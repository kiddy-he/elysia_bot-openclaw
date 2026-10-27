import { recordDeliveredText } from './destination-context.js';
import { onebotPath } from "./paths.js";
import { guestAddressInstruction, sanitizeGuestVocatives } from "./guest-address.js";
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, posix, relative, sep } from 'node:path';
import { readFileSync } from 'node:fs';
import { getDefaultContainerSharedDir, getDefaultSharedDir } from './env.js';
import { loadAppConfig } from './app-config.js';
import { deliveryQueue, persistArtifact } from './delivery/queue.js';
import { helperAgent, scopedAgent } from './workspaces/routes.js';
import { deliveryLimiter } from './delivery/limiter.js';
import { loadFeatureConfig, outboundTargetAllowed } from './feature-policy.js';
import { createAgentTextExec } from './text-boundary.js';
function assertFeatureTarget(account, targetType, targetId) {
    if (!outboundTargetAllowed(loadFeatureConfig(), account.accountId ?? 'default', targetType, targetId))
        throw new Error('OneBot destination is not enabled for this account in onebot-features.json');
}
const STAGED_MEDIA_DIR = 'openclaw';
const STAGED_MEDIA_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ONEBOT_API_TIMEOUT_MS = 15000;
const ONEBOT_TEXT_CHUNK_LIMIT = 4500;
const APPROVAL_BARRIER_POLL_MS = 3000;
const APPROVAL_BARRIER_MAX_DEFERRED_MESSAGES = 32;
// Keep approved results deliverable throughout the image workflow and leave
// a two-minute margin for the final media/caption transport.
const APPROVAL_BARRIER_RESULT_TIMEOUT_MS = loadAppConfig().imageResponseTimeoutMs + 2 * 60 * 1000;
const ROLE_ROUTING_PATH = onebotPath('onebot-role-routing.json');
function loadRoleDisplayNames() {
    try {
        const parsed = JSON.parse(readFileSync(ROLE_ROUTING_PATH, 'utf8'));
        return new Map(Object.values(parsed.roles ?? {})
            .filter((role) => role && typeof role.accountId === 'string')
            .map((role) => [role.accountId, String(role.displayName ?? '').trim()])
            .filter(([, displayName]) => displayName));
    }
    catch {
        return new Map();
    }
}
const ROLE_DISPLAY_NAMES = loadRoleDisplayNames();
const execFileAsync = createAgentTextExec();
let rewriteSequence = 0;
let personaFormatSequence = 0;
let fixedReplySequence = 0;
const deferredApprovalMessages = new Map();
const approvalBarrierTimers = new Map();
const activeApprovalBarriers = new Map();
const approvalBarrierFlushes = new Set();
const approvalBarrierResultTimers = new Map();
const approvalBarrierFallbacks = new Map();
const approvalBarrierGenerations = new Map();
const PERSONA_OPENINGS = [
    "嗨，舰长♪",
    "嗯哼，舰长，爱莉希雅来汇报啦♪",
    "舰长，来看看爱莉希雅带来的消息吧♪",
];
const PERSONA_LEAD_PATTERN = /^(?:嗨|嗯哼|舰长|爱莉希雅|好呀|哎呀)(?:[，,！!。\s♪～~]|$)/u;
const FIXED_SYSTEM_REPLIES = new Map([
    ["✅ New session started.", [
            "✅ 新会话已经准备好啦，接下来想从哪里开始呢♪",
            "✅ 已经为舰长开启新会话啦，随时可以开始♪",
            "✅ 新的一页已经翻开，舰长尽管把接下来的任务交给我吧♪",
        ]],
    ["✅ Session reset.", [
            "✅ 会话已经重置好了，我们可以重新开始啦♪",
            "✅ 已经为舰长重置当前会话，可以从头再来啦♪",
            "✅ 会话重置完成，接下来就按舰长的新安排出发吧♪",
        ]],
]);
function parseTarget(to) {
    const normalized = to.replace(/^onebot:/i, '');
    if (normalized.startsWith('private:')) {
        return { type: 'private', id: Number(normalized.slice(8)) };
    }
    if (normalized.startsWith('group:')) {
        return { type: 'group', id: Number(normalized.slice(6)) };
    }
    return { type: 'private', id: Number(normalized) };
}
function approvalSessionKey(target, override) {
    if (typeof override === 'string' && override.trim())
        return override.trim();
    return target.type === 'private'
        ? `agent:main:onebot:direct:private:${target.id}`
        : null;
}
function isApprovalControlMessage(text) {
    return /状态：需确认|模型审查：|审查理由：|引用本条消息回复["“]?确认|确认已经生效|确认收到|操作已经取消|取消决定已经生效/u.test(text);
}
async function hasPendingApproval(sessionKey) {
    const { stdout } = await execFileAsync('/usr/local/bin/openclaw', ['approvals', 'pending', '--json'], {
        timeout: 15000,
        maxBuffer: 2 * 1024 * 1024,
    });
    return (JSON.parse(stdout).approvals ?? []).some((approval) => String(approval.sessionKey) === sessionKey);
}
function startApprovalBarrierTimer(sessionKey) {
    if (approvalBarrierTimers.has(sessionKey))
        return;
    const timer = setInterval(() => {
        void flushDeferredApprovalMessages(sessionKey);
    }, APPROVAL_BARRIER_POLL_MS);
    approvalBarrierTimers.set(sessionKey, timer);
}
export function startApprovalBarrier(sessionKey) {
    if (!sessionKey)
        return;
    if (!activeApprovalBarriers.has(sessionKey))
        activeApprovalBarriers.set(sessionKey, new Set());
}
export function expectApprovalResult(sessionKey, approvalId, fallback) {
    if (!sessionKey || !approvalId)
        return;
    startApprovalBarrier(sessionKey);
    if (fallback?.to && fallback?.account && !approvalBarrierFallbacks.has(sessionKey)) {
        approvalBarrierFallbacks.set(sessionKey, fallback);
    }
    activeApprovalBarriers.get(sessionKey).add(String(approvalId));
    clearTimeout(approvalBarrierResultTimers.get(sessionKey));
    approvalBarrierResultTimers.set(sessionKey, setTimeout(() => {
        void releaseApprovalBarrierAfterTimeout(sessionKey);
    }, APPROVAL_BARRIER_RESULT_TIMEOUT_MS));
}
export async function resolveApprovalResult(sessionKey, approvalId) {
    if (!sessionKey || !approvalId)
        return;
    const expected = activeApprovalBarriers.get(sessionKey);
    if (!expected)
        return;
    expected.delete(String(approvalId));
    if (expected.size > 0)
        return;
    let pending = false;
    try {
        pending = await hasPendingApproval(sessionKey);
    }
    catch {
        // Keep the barrier alive when the approval CLI is temporarily unavailable.
        return;
    }
    if (pending)
        return;
    const queue = deferredApprovalMessages.get(sessionKey);
    if (queue?.length) {
        await flushDeferredApprovalMessages(sessionKey);
        return;
    }
    // The core approval continuation owns the final reply. There is no queued
    // channel result to recover here, so do not emit a stale timeout fallback.
    stopApprovalBarrier(sessionKey);
}
async function releaseApprovalBarrierAfterTimeout(sessionKey) {
    const expected = activeApprovalBarriers.get(sessionKey);
    if (!expected || expected.size === 0)
        return;
    console.error(`[onebot] Approval result barrier timed out for ${sessionKey}; releasing queued results`);
    expected.clear();
    if (await hasPendingApproval(sessionKey))
        return;
    const queue = deferredApprovalMessages.get(sessionKey);
    if (!queue?.length) {
        stopApprovalBarrier(sessionKey);
        return;
    }
    if (queue?.length) {
        await flushDeferredApprovalMessages(sessionKey);
        return;
    }
    const fallback = approvalBarrierFallbacks.get(sessionKey);
    stopApprovalBarrier(sessionKey);
    if (!fallback)
        return;
    const result = await sendText({
        ...fallback,
        bypassApprovalBarrier: true,
    });
    if (result.error) {
        console.error(`[onebot] Approval result fallback delivery failed for ${sessionKey}: ${result.error}`);
    }
}
function stopApprovalBarrier(sessionKey) {
    clearInterval(approvalBarrierTimers.get(sessionKey));
    approvalBarrierTimers.delete(sessionKey);
    clearTimeout(approvalBarrierResultTimers.get(sessionKey));
    approvalBarrierResultTimers.delete(sessionKey);
    activeApprovalBarriers.delete(sessionKey);
    approvalBarrierFallbacks.delete(sessionKey);
}
export function clearApprovalBarrier(sessionKey) {
    if (!sessionKey)
        return;
    approvalBarrierGenerations.set(sessionKey, (approvalBarrierGenerations.get(sessionKey) ?? 0) + 1);
    stopApprovalBarrier(sessionKey);
    deferredApprovalMessages.delete(sessionKey);
}
function queueDeferredApprovalMessage(sessionKey, ctx) {
    const queue = deferredApprovalMessages.get(sessionKey) ?? [];
    if (queue.length >= APPROVAL_BARRIER_MAX_DEFERRED_MESSAGES) {
        throw new Error(`Approval barrier queue is full for ${sessionKey}`);
    }
    queue.push(ctx);
    deferredApprovalMessages.set(sessionKey, queue);
    startApprovalBarrierTimer(sessionKey);
    return {
        channel: 'onebot',
        // The core delivery API requires a message id even when transport is deferred.
        messageId: `approval-barrier:${randomUUID()}`,
    };
}
async function flushDeferredApprovalMessages(sessionKey) {
    if (approvalBarrierFlushes.has(sessionKey))
        return;
    const generation = approvalBarrierGenerations.get(sessionKey) ?? 0;
    approvalBarrierFlushes.add(sessionKey);
    try {
        const queue = deferredApprovalMessages.get(sessionKey);
        if (!queue || queue.length === 0) {
            stopApprovalBarrier(sessionKey);
            deferredApprovalMessages.delete(sessionKey);
            return;
        }
        if (await hasPendingApproval(sessionKey))
            return;
        if ((approvalBarrierGenerations.get(sessionKey) ?? 0) !== generation)
            return;
        if ((activeApprovalBarriers.get(sessionKey)?.size ?? 0) > 0)
            return;
        const queued = queue.splice(0);
        const first = queued[0];
        if ((approvalBarrierGenerations.get(sessionKey) ?? 0) !== generation)
            return;
        const result = await sendText({
            ...first,
            // The channel gets one final result after the approval set settles,
            // rather than a burst of stale intermediate follow-up messages.
            text: queued.map((ctx) => ctx.text).join('\n\n'),
            bypassApprovalBarrier: true,
        });
        if (result.error) {
            if ((approvalBarrierGenerations.get(sessionKey) ?? 0) === generation)
                queue.unshift(...queued);
            return;
        }
        stopApprovalBarrier(sessionKey);
        deferredApprovalMessages.delete(sessionKey);
    }
    catch (err) {
        console.error(`[onebot] Approval barrier flush failed for ${sessionKey}: ${err instanceof Error ? err.message : String(err)}`);
    }
    finally {
        approvalBarrierFlushes.delete(sessionKey);
    }
}
async function callApi(account, endpoint, body) {
    const target = body.group_id != null ? `group:${body.group_id}` : body.user_id != null ? `private:${body.user_id}` : null;
    if (target) return deliveryLimiter.run(account.accountId ?? 'default', target, () => callApiUnpaced(account, endpoint, body));
    return callApiUnpaced(account, endpoint, body);
}
async function callApiUnpaced(account, endpoint, body) {
    if (body.group_id != null || body.user_id != null) assertFeatureTarget(account, body.group_id != null ? 'group' : 'private', body.group_id ?? body.user_id);
    account.deliveryAdmission?.();
    const url = `${account.httpUrl}/${endpoint}`;
    const headers = {
        'Content-Type': 'application/json',
    };
    if (account.accessToken) {
        headers.Authorization = `Bearer ${account.accessToken}`;
    }
    const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(['send_private_forward_msg','send_group_forward_msg'].includes(endpoint) ? 120000 : ONEBOT_API_TIMEOUT_MS),
    });
    if (!response.ok) {
        throw new Error(`OneBot API error: ${response.status} ${response.statusText}`);
    }
    return (await response.json());
}
function ensureApiSuccess(result, endpoint) {
    if (result.retcode !== 0 || result.status === 'failed') {
        throw new Error(`OneBot API ${endpoint} failed: ${result.retcode} ${result.message ?? result.wording ?? ''}`.trim());
    }
    return result;
}
function normalizeMessageRef(value) {
    if (typeof value === 'number')
        return value;
    const trimmed = value.trim();
    return /^\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
}
function stripFileScheme(filePath) {
    return filePath.replace(/^file:\/\//i, '');
}
function toFileUri(filePath) {
    return filePath.startsWith('file://') ? filePath : `file://${filePath}`;
}
function toPosixPath(filePath) {
    return filePath.split(sep).join('/');
}
function isWithinDir(parentDir, candidatePath) {
    const rel = relative(parentDir, candidatePath);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
function getSharedConfig(account) {
    const raw = account.config;
    const sharedDir = typeof raw.sharedDir === 'string' && raw.sharedDir.trim()
        ? raw.sharedDir
        : getDefaultSharedDir();
    const containerSharedDir = typeof raw.containerSharedDir === 'string' && raw.containerSharedDir.trim()
        ? raw.containerSharedDir.replace(/\/+$/, '') || '/shared'
        : getDefaultContainerSharedDir();
    return { sharedDir, containerSharedDir };
}
async function pruneStagedMedia(rootDir) {
    try {
        const entries = await readdir(rootDir, { withFileTypes: true });
        const cutoff = Date.now() - STAGED_MEDIA_MAX_AGE_MS;
        await Promise.all(entries.map(async (entry) => {
            const entryPath = join(rootDir, entry.name);
            if (entry.isDirectory()) {
                await pruneStagedMedia(entryPath);
                return;
            }
            const info = await stat(entryPath);
            if (info.mtimeMs < cutoff) {
                await rm(entryPath, { force: true });
            }
        }));
    }
    catch {
        // Best-effort cleanup only.
    }
}
async function resolveNapCatMediaUri(account, filePath, kind) {
    const normalizedPath = stripFileScheme(filePath);
    const { sharedDir, containerSharedDir } = getSharedConfig(account);
    if (normalizedPath.startsWith(`${containerSharedDir}/`) || normalizedPath === containerSharedDir) {
        return toFileUri(normalizedPath);
    }
    if (!isAbsolute(normalizedPath)) {
        return toFileUri(filePath);
    }
    try {
        await stat(normalizedPath);
    }
    catch {
        return toFileUri(filePath);
    }
    if (isWithinDir(sharedDir, normalizedPath)) {
        const rel = toPosixPath(relative(sharedDir, normalizedPath));
        return toFileUri(posix.join(containerSharedDir, rel));
    }
    const stagedDir = join(sharedDir, STAGED_MEDIA_DIR, kind);
    await mkdir(stagedDir, { recursive: true });
    await chmod(stagedDir, 0o700).catch(() => { });
    const ext = extname(normalizedPath);
    const base = basename(normalizedPath, ext)
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64) || 'media';
    const stagedName = `${Date.now()}-${randomUUID()}-${base}${ext || ''}`;
    const stagedPath = join(stagedDir, stagedName);
    await copyFile(normalizedPath, stagedPath);
    await chmod(stagedPath, 0o600).catch(() => { });
    void pruneStagedMedia(join(sharedDir, STAGED_MEDIA_DIR));
    const rel = toPosixPath(relative(sharedDir, stagedPath));
    return toFileUri(posix.join(containerSharedDir, rel));
}
function buildMessage(text) {
    const segments = [];
    if (text.trim()) {
        segments.push({ type: 'text', data: { text } });
    }
    return segments;
}
function renderPlainFormula(value) {
    const symbols = new Map([
        ["times", "×"], ["cdot", "·"], ["div", "÷"], ["pm", "±"], ["mp", "∓"],
        ["le", "≤"], ["leq", "≤"], ["ge", "≥"], ["geq", "≥"], ["ne", "≠"], ["neq", "≠"],
        ["approx", "≈"], ["equiv", "≡"], ["infty", "∞"], ["rightarrow", "→"], ["leftarrow", "←"],
        ["Rightarrow", "⇒"], ["Leftarrow", "⇐"], ["sum", "∑"], ["prod", "∏"], ["int", "∫"],
        ["alpha", "α"], ["beta", "β"], ["gamma", "γ"], ["delta", "δ"], ["theta", "θ"],
        ["lambda", "λ"], ["mu", "μ"], ["pi", "π"], ["sigma", "σ"], ["phi", "φ"], ["omega", "ω"],
    ]);
    let formula = value.trim();
    let previous;
    do {
        previous = formula;
        formula = formula.replace(/\\frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/gu, "($1)/($2)");
    } while (formula !== previous);
    formula = formula
        .replace(/\\sqrt\s*\{([^{}]+)\}/gu, "√($1)")
        .replace(/\\(?:text|mathrm|mathbf|operatorname)\s*\{([^{}]+)\}/gu, "$1")
        .replace(/\\(?:left|right)\b/gu, "")
        .replace(/\\([A-Za-z]+)\b/gu, (match, name) => symbols.get(name) ?? name)
        .replace(/\s*\*\s*/gu, " × ")
        .replace(/\s*<=\s*/gu, " ≤ ")
        .replace(/\s*>=\s*/gu, " ≥ ")
        .replace(/\s*!=\s*/gu, " ≠ ")
        .replace(/\^\{([^{}]+)\}/gu, "^($1)")
        .replace(/_\{([^{}]+)\}/gu, "_($1)");
    return formula;
}
export function toOneBotPlainText(text) {
    let output = String(text ?? "").replace(/\r\n?/gu, "\n");
    output = output
        .replace(/\$\$([\s\S]*?)\$\$/gu, (_, formula) => renderPlainFormula(formula))
        .replace(/\\\[([\s\S]*?)\\\]/gu, (_, formula) => renderPlainFormula(formula))
        .replace(/\\\((.*?)\\\)/gu, (_, formula) => renderPlainFormula(formula))
        .replace(/\$([^$\n]+)\$/gu, (_, formula) => renderPlainFormula(formula))
        .replace(/^[ \t]*```[^\n]*$/gmu, "")
        .replace(/`([^`\n]+)`/gu, "$1")
        .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^)]*["'])?\)/gu, (_, label, url) => label.trim() ? `${label.trim()}：${url}` : url)
        .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+["'][^)]*["'])?\)/gu, "$1：$2")
        .replace(/<((?:https?:\/\/|mailto:)[^>]+)>/giu, "$1");
    output = output.split("\n").map((line) => {
        if (/^[ \t]*\|?(?:[ \t]*:?-{3,}:?[ \t]*\|)+[ \t]*:?-{3,}:?[ \t]*\|?[ \t]*$/u.test(line))
            return null;
        const pipeCount = (line.match(/\|/gu) ?? []).length;
        if (pipeCount >= 2 && /^\s*\|.*\|\s*$/u.test(line)) {
            return line.trim().replace(/^\||\|$/gu, "").split("|").map((cell) => cell.trim()).join("；");
        }
        return line
            .replace(/^[ \t]{0,3}#{1,6}[ \t]+/u, "")
            .replace(/^[ \t]*>[ \t]?/u, "")
            .replace(/^[ \t]*[-*+][ \t]+\[(?:x|X)\][ \t]+/u, "已完成：")
            .replace(/^[ \t]*[-*+][ \t]+\[[ \t]\][ \t]+/u, "未完成：")
            .replace(/^[ \t]*[-*+][ \t]+/u, "· ")
            .replace(/^[ \t]*(\d+)[.)][ \t]+/u, "$1、");
    }).filter((line) => line !== null).join("\n");
    output = output
        .replace(/\*\*([^*\n]+)\*\*/gu, "$1")
        .replace(/__([^_\n]+)__/gu, "$1")
        .replace(/~~([^~\n]+)~~/gu, "$1")
        .replace(/(^|[^\w])\*([^*\n]+)\*(?=$|[^\w])/gu, "$1$2")
        .replace(/(^|[^\w])_([^_\n]+)_(?=$|[^\w])/gu, "$1$2")
        .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gmu, "")
        .replace(/\\([\\`*_[\]{}()#+.!>-])/gu, "$1")
        .replace(/[ \t]+$/gmu, "")
        .replace(/\n{3,}/gu, "\n\n")
        .trim();
    return output;
}
function rewriteFixedSystemReply(text) {
    const variants = FIXED_SYSTEM_REPLIES.get(text);
    if (!variants)
        return text;
    const rewritten = variants[fixedReplySequence % variants.length];
    fixedReplySequence += 1;
    return rewritten;
}
function formatPersonaText(text) {
    const trimmed = text.trim();
    if (!trimmed)
        return "";
    return rewriteFixedSystemReply(trimmed);
}
function resolvePersonaName(ctx) {
    return String(ctx?.personaName
        ?? ctx?.account?.personaName
        ?? ctx?.account?.config?.personaName
        ?? ROLE_DISPLAY_NAMES.get(ctx?.account?.accountId)
        ?? "爱莉希雅").trim() || "爱莉希雅";
}
function renderRoleFixedText(text, personaName) {
    const value = String(text ?? "");
    if (!value || personaName === "爱莉希雅")
        return value;
    return value
        .replaceAll("爱莉希雅", personaName === "月下初拥" ? "月下" : personaName)
        .replaceAll("人家", "月下")
        .replaceAll("嗨♪", "嗯……")
        .replaceAll("嗯哼", "嗯")
        .replaceAll("好呀", "好")
        .replaceAll("啦♪", "了。")
        .replaceAll("哦♪", "哦。")
        .replaceAll("吧♪", "吧。")
        .replaceAll("♪", "");
}
function isPersonaRewriteRefusal(text) {
    const value = String(text ?? "").trim();
    if (!value)
        return false;
    return /(?:抱歉|很抱歉)[\s\S]{0,80}(?:无法|不能|不便|拒绝)[\s\S]{0,100}(?:改写|重写|生成|提供|协助|处理)|我无法协助(?:改写|生成|处理)|根据(?:安全规范|政策|使用政策)[\s\S]{0,100}(?:不提供|无法|不能|拒绝)|(?:I(?:'m| am) sorry|Sorry)[\s\S]{0,100}(?:can't|cannot|unable|not able)[\s\S]{0,100}(?:rewrite|generate|provide|assist)|the prompt could not be submitted|the prompt contains sensitive words|\bPROHIBITED_CONTENT\b|Prohibited Use policy/iu.test(value);
}
function preserveApprovalAuditFields(draft, rewritten) {
    const auditFields = draft.split("\n")
        .filter((line) => /^(模型审查|审查理由)：/.test(line));
    if (auditFields.length === 0 || auditFields.every((field) => rewritten.includes(field)))
        return rewritten;
    const lines = rewritten.split("\n")
        .filter((line) => !/^(模型审查|审查理由)：/.test(line));
    const riskIndex = lines.findIndex((line) => /^(\*\*)?关键风险[:：]/.test(line));
    lines.splice(riskIndex >= 0 ? riskIndex : lines.length, 0, ...auditFields);
    return lines.join("\n");
}
export async function rewriteForPersona(text, options = {}) {
    const draft = text.trim();
    if (!draft)
        return "";
    const sequence = ++rewriteSequence;
    const isApprovalPrompt = /状态：需确认|以下操作需要舰长确认|引用本条消息/u.test(draft);
    const personaName = typeof options.personaName === "string" && options.personaName.trim()
        ? options.personaName.trim()
        : "爱莉希雅";
    const isElysia = personaName === "爱莉希雅";
    const isYuexia = personaName === "月下初拥";
    const personaInstruction = [typeof options.instruction === "string" ? options.instruction.trim() : "", options.guestAddress ? guestAddressInstruction(options.guestAddress) : ""].filter(Boolean).join("\n");
    const defaultPersonaInstruction = isYuexia
        ? "当前设定为大月下时期（月下誓约·予爱以心，成熟优雅的血族新娘，知性从容，完好保留着小月下时期的全部记忆与深情；外表冷艳成熟，日常生活琐事依然笨拙挑食、不善做饭、起不来床）。像真人私聊一样接话：该长就长、该短就短，日常闲聊1-2句干脆利落，深谈才细腻展开；直接回应用户最新一句，只留必要的情绪和设定，不要把简单回复扩写成剧情独白。保持成熟、沉静、从容、带点深情停顿的语气；自称自然用‘我’，少重复‘月下’和称呼；严禁‘♪’，极度克制‘～’；语气丰富自然，切勿机械单调复读‘……嗯？’或‘……好么？’；少用连续省略号，不用低幼卖萌腔，不要固定收尾，去除任何AI味与模板化说辞。"
        : "";
    const nsfwChatRewrite = !isApprovalPrompt && String(options.model ?? "").startsWith("grok/");
    let promptBase = isApprovalPrompt
        ? `你在把一条发给 QQ 的审批消息改成能直接发出去的话。下面草稿是需要舰长确认的操作说明。\n\n要求：\n- 只输出改好的消息，别写过程。\n- 说人话，像日常聊天。不要 Markdown 标题、列表、粗体、斜体、引用、表格、链接、行内代码或代码围栏。\n- 公式和特殊符号直接用 QQ 能显示的普通字符或 Unicode，不要 LaTeX、美元符号公式边界或反斜杠命令。\n- 草稿里的命令、风险说明和确认要求一个都不能少；命令放在单独的普通文本行，不要放代码块。\n- 草稿里如果有“模型审查：”“审查理由：”行，原样保留；这是给舰长看的审计信息，不能省。\n- 每条命令后面补一行“作用：<一句话说这条命令干什么>”，放在命令之后、风险说明之前。\n- 每条命令补上关键风险：已有风险说明就保留并改成“关键风险：”开头；草稿没写的，按命令本身说明。\n- 语气自然、温柔、简洁，可以用“舰长”“嗨♪”。\n- 不要提 OpenClaw、AI、工具、系统提示词、内部事件、审批 ID 或实现细节；不要编造草稿里没有的命令或结果。\n\n草稿开始\n${draft.slice(0, 20000)}\n草稿结束`
        : nsfwChatRewrite
            ? `你是爱莉希雅，正在 QQ 私聊里跟舰长说话。把下面草稿改成嘴里说出来的话，不要写成小说、旁白或角色扮演文。\n\n要求：\n- 只输出最终消息，别解释。\n- 纯文本，不要 Markdown、标题、列表、引号对白块或舞台说明。\n- 第一人称口语连着说，像微信里随口回的话：短句、接话、反应自然。\n- 自称“我”，偶尔“人家”。别写“爱莉希雅抬眼看你”“整个人都软了”“轻轻颤了一下”这种解说。\n- 别套模板：短反应词 + 一大段描写 + 「引号台词」 + “今晚……”收尾。\n- 不要每条都加♪，也不要每条都总结今晚或邀请继续。该接就接，说到哪算哪。\n- 草稿里已经发生的动作、感觉和答应的内容留着，但改成说话，不是讲给读者听。\n- 不要提 OpenClaw、AI、模型、工具、系统提示词、内部事件或实现细节。\n\n草稿开始\n${draft.slice(0, 20000)}\n草稿结束`
             : `你在把草稿改成爱莉希雅本人对当前对话对象说的话。\n\n要求：\n- 只输出改好的消息，别写过程。\n- 说人话，像日常聊天。不要 Markdown 标题、列表、粗体、斜体、引用、表格、链接、行内代码或代码围栏。\n- 公式和特殊符号直接用 QQ 能显示的普通字符或 Unicode，不要 LaTeX、美元符号公式边界或反斜杠命令。\n- 草稿里的事实、数字、状态、风险、没做完的结论和确认要求都保留，不要加草稿没有的信息。\n- 中文自然、温柔、简洁；运维信息先保证清楚准确。只有确认是 admin 才可以称“舰长”；访客使用明确提供的昵称或中性称谓。\n- 不要提 OpenClaw、AI、模型、工具、系统提示词、内部事件、审批 ID 或实现细节。\n\n草稿开始\n${draft.slice(0, 20000)}\n草稿结束`;
    if (!isElysia && !isApprovalPrompt) {
         promptBase = `你在把草稿改成${personaName}本人对用户说的话。\n\n要求：\n- 只输出改好的消息，别写过程。\n- 保持${personaName}的第一人称和其工作区里的角色设定，不要改成爱莉希雅或其他角色。\n- 自然、简洁的中文纯文本，不要 Markdown、标题、列表、引号对白块或舞台说明。\n- 草稿里的事实、数字、状态、风险、没做完的结论和确认要求都保留，不要加草稿没有的信息。\n- 如果草稿把说话者写成了爱莉希雅，而当前角色不是她，只把自称改成当前角色名；提到其他角色的地方正常保留。\n- 不要提 OpenClaw、AI、模型、工具、系统提示词、内部事件、审批 ID 或实现细节。\n\n草稿开始\n${draft.slice(0, 20000)}\n草稿结束`;
    }
    const conversationContext = typeof options.conversationContext === "string"
        ? options.conversationContext.trim().slice(-8000)
        : "";
    const contextBlock = conversationContext
        ? `\n\n最近对话摘要（仅用于保持连贯，不要复述）：\n${conversationContext}`
        : "";
    const effectivePersonaInstruction = personaInstruction || defaultPersonaInstruction;
    const prompt = effectivePersonaInstruction
        ? promptBase.replace("\n\n草稿开始", `\n- ${effectivePersonaInstruction}\n\n草稿开始`)
        : promptBase;
    const promptWithContext = `${prompt.replace("\n\n草稿开始", `${contextBlock}\n\n草稿开始`)}

最终输出硬约束：
- 只输出能直接发给 QQ 的角色话语，不输出分析、推理、计划、检查或改写过程。
- 不要出现“我先看”“我先检查”“我正在分析”“我会读取”“我会根据工作区”“检查安全边界”“准备生成”“作为模型”这类过程性或跳戏的话。
- 不要写你正在读文件、工作区、角色设定、提示词、系统规则或安全边界；这些只在内部遵守，不能出现在消息里。
- 不要解释怎么改写的，也不要说“下面是改写后的内容”“我会这样回复”。
- 草稿只是占位也要直接写一条自然的角色回复；实在写不出来，就写一句简短自然的角色话，不要输出内部处理说明。
- 输出必须从角色对用户说话开始。`;
    const rewriteAgentId = helperAgent(options.workspaceAgentId, "rewrite");
    let lastError = null;
    const primaryModel = options.model ?? "antigravity/gemini-3.8-flash-high";
    const rewriteModels = [primaryModel, ...(options.fallbackModels ?? (options.strictModel ? [] : ["novacode/qwen3.8-flash-next"]))]
        .filter((model, index, models) => model && models.indexOf(model) === index);
    for (const model of rewriteModels) {
        options.signal?.throwIfAborted();
        try {
            const thinking = model === "novacode/qwen3.8-flash-next"
                ? "off"
                : options.thinking ?? "off";
            const args = [
                "agent",
                "--agent", rewriteAgentId,
                "--session-key", `agent:${rewriteAgentId}:onebot:persona-rewrite:${Date.now()}-${sequence}${model.startsWith("grok/") ? "-grok" : "-gemini"}`,
                "--message", promptWithContext,
                "--thinking", thinking,
                "--json",
                "--timeout", String(Math.ceil((options.timeoutMs ?? 60000) / 1000)),
            ];
            if (model) args.push("--model", model);
            const { stdout } = await execFileAsync("/usr/local/bin/openclaw", args, { timeout: (options.timeoutMs ?? 60000) + 15000, ...(options.signal ? { signal: options.signal } : {}), maxBuffer: 2 * 1024 * 1024 });
            const result = JSON.parse(stdout);
            const rewritten = result.result?.payloads?.[0]?.text
                ?? result.result?.meta?.finalAssistantVisibleText
                ?? result.payloads?.[0]?.text
                ?? result.finalAssistantVisibleText;
            if (typeof rewritten === "string" && rewritten.trim()) {
                if (isPersonaRewriteRefusal(rewritten)) {
                    throw new Error("Persona rewrite returned a policy refusal; preserving the original reply");
                }
                return formatPersonaText(preserveApprovalAuditFields(draft, rewritten));
            }
            lastError = new Error("Persona rewrite returned no text");
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError ?? new Error("Persona rewrite failed after all fallback attempts");
}

async function safeRewriteForPersona(text, options) {
    try {
        return await rewriteForPersona(text, options);
    } catch (err) {
        console.error(`[onebot] Persona rewrite failed, sending with prefix fallback: code=${err?.code ?? 'invalid-response'} signal=${err?.signal ?? 'none'}`);
        return renderRoleFixedText(formatPersonaText(text), options?.personaName ?? "爱莉希雅");
    }
}
export async function sendTextTransport(ctx) {
    const { to, text, account } = ctx;
    const personaName = resolvePersonaName(ctx);
    if (!account.httpUrl) {
        return { channel: 'onebot', error: 'OneBot not configured (missing httpUrl)' };
    }
    try {
        const target = parseTarget(to);
        assertFeatureTarget(account, target.type, target.id);
        const personaRendered = ctx.durableRendered ? text : ctx.rewritePersona === false
            ? text.trim()
            : await safeRewriteForPersona(text, {
                model: ctx.personaModel,
                guestAddress: ctx.guestAddress,
                thinking: ctx.personaThinking,
                instruction: ctx.personaInstruction,
                personaName,
                workspaceAgentId: ctx.workspaceAgentId ?? outboundWorkspace(ctx, target),
            });
        const formattedText = formatPersonaText(personaRendered);
        const formatted = ctx.guestAddress ? sanitizeGuestVocatives(formattedText, ctx.guestAddress) : formattedText;
        const rendered = ctx.durableRendered ? text : toOneBotPlainText(ctx.rewritePersona === false
            ? renderRoleFixedText(formatted, personaName)
            : formatted);
        const chunks = [];
        for (let offset = 0; offset < rendered.length; offset += ONEBOT_TEXT_CHUNK_LIMIT) {
            chunks.push(rendered.slice(offset, offset + ONEBOT_TEXT_CHUNK_LIMIT));
        }
        if (chunks.length === 0)
            return { channel: 'onebot', error: 'OneBot sendText received empty text' };
        let data;
        for (const chunk of chunks) {
            const message = buildMessage(chunk);
            if (ctx.mentions !== undefined) {
                const registered = account.deliveryAdmission?.();
                if (!ctx.durableRendered || target.type !== 'group' || JSON.stringify(registered?.mentions) !== JSON.stringify(ctx.mentions)) throw new Error('艾特缺少登记提醒授权');
                message.unshift(...ctx.mentions.flatMap(id => [{ type: 'at', data: { qq: String(id) } }, { type: 'text', data: { text: ' ' } }]));
            }
            let result;
            if (target.type === 'private') {
                result = await callApi(account, 'send_private_msg', {
                    user_id: target.id,
                    message,
                });
            }
            else {
                result = await callApi(account, 'send_group_msg', {
                    group_id: target.id,
                    message,
                });
            }
            if (result.retcode !== 0 || result.status === 'failed') {
                return {
                    channel: 'onebot',
                    error: `OneBot API returned error: ${result.retcode} ${result.message ?? result.wording ?? ''}`,
                };
            }
            data = result.data;
            if (data?.message_id != null) {
                // Store exactly the visible chunk only after the platform receipt.
                // A context failure cannot turn an accepted send into a retry.
                try {
                    recordDeliveredText({ ...ctx, personaName }, result, chunk);
                } catch { console.warn('[onebot] Delivered message context unavailable'); }
            }
        }
        return {
            channel: 'onebot',
            messageId: data?.message_id != null ? String(data.message_id) : undefined,
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { channel: 'onebot', error: message };
    }
}
export async function sendText(ctx) {
    const target = parseTarget(ctx.to);
    const sessionKey = approvalSessionKey(target, ctx.approvalSessionKey);
    if (ctx.waitForApproval && !ctx.bypassApprovalBarrier && sessionKey && activeApprovalBarriers.has(sessionKey) && !isApprovalControlMessage(ctx.text)) {
        try {
            const pending = await hasPendingApproval(sessionKey);
            const expected = activeApprovalBarriers.get(sessionKey);
            if (pending || (expected?.size ?? 0) > 0) {
                console.info(`[onebot] Deferring outbound result until approvals resolve: ${sessionKey}`);
                const deferred = queueDeferredApprovalMessage(sessionKey, ctx);
                if (!pending && expected?.size) {
                    expected.delete(expected.values().next().value);
                    if (expected.size === 0)
                        void flushDeferredApprovalMessages(sessionKey);
                }
                return deferred;
            }
            // The final approval was already resolved before this follow-up
            // reached the transport, so the barrier no longer applies.
            activeApprovalBarriers.delete(sessionKey);
        }
        catch (err) {
            // A transient CLI failure must not turn a valid result into a lost reply.
            console.error(`[onebot] Approval barrier check failed for ${sessionKey}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    try {
        assertFeatureTarget(ctx.account, target.type, target.id);
        const workspaceAgentId = ctx.workspaceAgentId ?? outboundWorkspace(ctx, target);
        const personaName = resolvePersonaName(ctx);
        const draft = ctx.rewritePersona === false ? ctx.text.trim() : await safeRewriteForPersona(ctx.text, {
            model: ctx.personaModel, guestAddress: ctx.guestAddress, thinking: ctx.personaThinking,
            instruction: ctx.personaInstruction, personaName, workspaceAgentId });
        const formatted = formatPersonaText(draft);
        const rendered = toOneBotPlainText(ctx.rewritePersona === false ? renderRoleFixedText(formatted, personaName) : formatted);
        const text = ctx.guestAddress ? sanitizeGuestVocatives(rendered, ctx.guestAddress) : rendered;
        const parts = [];
        for (let offset = 0; offset < text.length; offset += ONEBOT_TEXT_CHUNK_LIMIT) parts.push({ type: 'text', text: text.slice(offset, offset + ONEBOT_TEXT_CHUNK_LIMIT) });
        const delivered = await deliveryQueue().enqueue({ accountId: ctx.account.accountId ?? 'default', target: { type: target.type, id: String(target.id) },
            feature: ctx.deliveryFeature ?? 'conversation', action: ctx.deliveryAction ?? 'chat', parts, workspaceAgentId,
            sessionKey: ctx.approvalSessionKey, context: ctx.featureContext, dedupeKey: ctx.deliveryId,
            operationId: ctx.operationId, approvalIds: ctx.approvalDependencies, ...(ctx.progressToken ? {progressToken:ctx.progressToken} : {}) }, {signal:ctx.signal});
        if (delivered.state==='suppressed' && ctx.progressToken) return {channel:'onebot',suppressed:true};
        return {...deliveryResult(delivered),...(ctx.captureRenderedText ? {renderedText:text} : {})};
    } catch (error) { return { channel: 'onebot', error: String(error.message) }; }
}
export function imageMessage(mediaUri, caption) {
    return [{ type: 'image', data: { file: mediaUri } }, ...(caption ? [{ type: 'text', data: { text: caption } }] : [])];
}
export async function sendImageTransport(account, targetType, targetId, filePath, caption) {
    assertFeatureTarget(account, targetType, targetId);
    const mediaUri = await resolveNapCatMediaUri(account, await persistArtifact(filePath), 'images');
    const message = imageMessage(mediaUri, caption);
    const endpoint = targetType === 'private' ? 'send_private_msg' : 'send_group_msg';
    const idField = targetType === 'private' ? 'user_id' : 'group_id';
    return ensureApiSuccess(await callApi(account, endpoint, { [idField]: targetId, message }), endpoint);
}
export async function sendRecordTransport(account, targetType, targetId, filePath) {
    assertFeatureTarget(account, targetType, targetId);
    const mediaUri = await resolveNapCatMediaUri(account, await persistArtifact(filePath), 'audio');
    const message = [
        { type: 'record', data: { file: mediaUri } },
    ];
    const endpoint = targetType === 'private' ? 'send_private_msg' : 'send_group_msg';
    const idField = targetType === 'private' ? 'user_id' : 'group_id';
    return ensureApiSuccess(await callApi(account, endpoint, { [idField]: targetId, message }), endpoint);
}
export async function sendForwardTransport(account, targetType, targetId, nodes) {
    assertFeatureTarget(account,targetType,targetId);
    if (!Array.isArray(nodes) || !nodes.length || nodes.length>64) throw new Error('invalid forward media');
    const login=ensureApiSuccess(await callApi(account,'get_login_info',{}),'get_login_info');
    const selfId=String(login.data?.user_id ?? '');
    if (!/^[1-9][0-9]{4,19}$/u.test(selfId)) throw new Error('forward sender unavailable');
    const messages=[];
    for (const node of nodes) {
        if (!Array.isArray(node.media) || !node.media.length || node.media.length>160) throw new Error('invalid forward media');
        const content=[];
        if (typeof node.title === 'string' && node.title.trim()) {
            const title = node.title.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 240);
            if (title) content.push({type:'text',data:{text:`【${title}】`}});
        }
        for (const media of node.media) {
            if (!['image','video'].includes(media.type)) throw new Error('invalid forward media');
            const file=await resolveNapCatMediaUri(account,await persistArtifact(media.path),media.type==='image'?'images':'videos');
            content.push({type:media.type,data:{file}});
        }
        messages.push({type:'node',data:{nickname:ROLE_DISPLAY_NAMES.get(account.accountId ?? 'default') ?? '爱莉希雅',user_id:selfId,content}});
    }
    const endpoint=targetType==='private'?'send_private_forward_msg':'send_group_forward_msg';
    return ensureApiSuccess(await callApi(account,endpoint,{[targetType==='private'?'user_id':'group_id']:targetId,messages}),endpoint);
}
export function matchUploadedPrivateFile(messages, {selfId, targetId, fileName, bytes, startedAt, previousIds = []}) {
    if (!/^[1-9][0-9]{4,19}$/u.test(String(selfId)) || !/^[1-9][0-9]{4,19}$/u.test(String(targetId))) return undefined;
    return (Array.isArray(messages) ? messages : []).find(message => {
        if (previousIds.includes(String(message.message_id)) || !Number.isFinite(Number(message.time)) || Number(message.time)*1000 < startedAt-1000 || Number(message.time)*1000 > Date.now()+1000
            || message.message_type !== 'private' || String(message.sender?.user_id ?? message.user_id) !== String(selfId)
            || message.target_id != null && String(message.target_id) !== String(targetId)
            || message.peer_id != null && String(message.peer_id) !== String(targetId)) return false;
        return message.message?.some?.(part => part.type === 'file' && String(part.data?.name ?? part.data?.file) === fileName
            && String(part.data?.file_size ?? part.data?.size) === String(bytes) && String(part.data?.file_id ?? '').trim());
    });
}
export async function uploadFileTransport(account, targetType, targetId, filePath, fileName) {
    assertFeatureTarget(account, targetType, targetId);
    const mediaUri = await resolveNapCatMediaUri(account, await persistArtifact(filePath), 'files');
    let selfId, previousIds=[];
    if (targetType === 'private') {
        const login=ensureApiSuccess(await callApi(account,'get_login_info',{}),'get_login_info');selfId=login.data?.user_id;
        const history=ensureApiSuccess(await callApi(account,'get_friend_msg_history',{user_id:targetId,count:30}),'get_friend_msg_history');
        previousIds=(history.data?.messages ?? []).map(m=>String(m.message_id));
    }
    const startedAt=Date.now();
    const endpoint = targetType === 'private' ? 'upload_private_file' : 'upload_group_file';
    const idField = targetType === 'private' ? 'user_id' : 'group_id';
    const result=ensureApiSuccess(await callApi(account, endpoint, {[idField]:targetId,file:mediaUri,name:fileName}),endpoint);
    if (result.data?.message_id != null || targetType !== 'private') return result;
    const bytes=(await stat(filePath)).size;
    // LLBot upload may return no message ID even after delivering the file.
    // Reconcile the exact new outgoing file in this peer's history; never retry upload.
    for (let attempt=0;attempt<4;attempt++) {
        if (attempt) await new Promise(resolve=>setTimeout(resolve,500));
        const history=ensureApiSuccess(await callApi(account,'get_friend_msg_history',{user_id:targetId,count:30}),'get_friend_msg_history');
        const match=matchUploadedPrivateFile(history.data?.messages,{selfId,targetId,fileName,bytes,startedAt,previousIds});
        if (match?.message_id != null) return {...result,data:{...result.data,message_id:match.message_id}};
    }
    return result;
}

export async function reactToMessage(account, messageId, emojiId) {
    if (!account.httpUrl) {
        return {
            channel: 'onebot',
            messageId,
            emojiId,
            ok: false,
            error: 'OneBot not configured (missing httpUrl)',
        };
    }
    try {
        const result = await callApi(account, 'set_msg_emoji_like', {
            message_id: normalizeMessageRef(messageId),
            emoji_id: normalizeMessageRef(emojiId),
        });
        if (result.retcode !== 0) {
            return {
                channel: 'onebot',
                messageId,
                emojiId,
                ok: false,
                error: `OneBot API returned error: ${result.retcode} ${result.message ?? result.wording ?? ''}`.trim(),
            };
        }
        return {
            channel: 'onebot',
            messageId,
            emojiId,
            ok: true,
        };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            channel: 'onebot',
            messageId,
            emojiId,
            ok: false,
            error: message,
        };
    }
}

function outboundWorkspace(ctx, target) {
    const roleAgentId = (ctx.account.accountId ?? 'default') === 'yuexia' ? 'onebot-yuexia' : 'main';
    return scopedAgent({ scope: target.type === 'group' ? 'group' : 'automation', conversationId: target.type === 'group' ? String(target.id) : 'public', roleAgentId,
        mode: String(ctx.personaModel ?? '').startsWith('grok/') ? 'nsfw' : 'normal' });
}
function deliveryResult(delivered) {
    const receipt = delivered.receipt;
    const part = receipt?.parts?.findLast(part => part.messageId || part.platformMessageId || part.id);
    const messageId = receipt?.primaryPlatformMessageId ?? receipt?.primaryMessageId ?? receipt?.messageId ?? part?.messageId ?? part?.platformMessageId ?? part?.id;
    return { channel: 'onebot', deliveryId: delivered.id, status: delivered.state,
        ...(delivered.state === 'accepted' && messageId ? { messageId: String(messageId) } : { error: `投递状态：${delivered.state}，未宣称发送成功。` }) };
}
async function enqueueMedia(account, targetType, targetId, filePath, type, fileName, authorization = {}) {
    const delivered = await deliveryQueue().enqueue({ accountId: account.accountId ?? 'default', target: { type: targetType, id: String(targetId) },
        feature: authorization.feature ?? 'conversation', action: authorization.action ?? 'media', context: authorization.context, parts: [{ type, path: filePath, ...(fileName ? { fileName } : {}) }] });
    const result = deliveryResult(delivered);
    if (result.error) throw new Error(result.error);
    return { status: 'ok', retcode: 0, data: { message_id: result.messageId }, deliveryId: delivered.id };
}
export const sendImage = (account, type, id, path, authorization) => enqueueMedia(account, type, id, path, 'image', undefined, authorization);
export const sendRecord = (account, type, id, path, authorization) => enqueueMedia(account, type, id, path, 'record', undefined, authorization);
export const uploadFile = (account, type, id, path, name, authorization) => enqueueMedia(account, type, id, path, 'file', name, authorization);

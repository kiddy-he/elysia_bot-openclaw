import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, posix, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { getDefaultContainerSharedDir, getDefaultSharedDir } from './env.js';
const STAGED_MEDIA_DIR = 'openclaw';
const STAGED_MEDIA_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ONEBOT_API_TIMEOUT_MS = 15000;
const ONEBOT_TEXT_CHUNK_LIMIT = 4500;
const APPROVAL_BARRIER_POLL_MS = 3000;
const APPROVAL_BARRIER_MAX_DEFERRED_MESSAGES = 32;
// Image generation can take the full ten-minute workflow timeout. Keep the
// approval barrier alive until the approved continuation can deliver its
// final text and media.
const APPROVAL_BARRIER_RESULT_TIMEOUT_MS = 12 * 60 * 1000;
const execFileAsync = promisify(execFile);
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
async function releaseApprovalBarrierAfterTimeout(sessionKey) {
    const expected = activeApprovalBarriers.get(sessionKey);
    if (!expected || expected.size === 0)
        return;
    console.error(`[onebot] Approval result barrier timed out for ${sessionKey}; releasing queued results`);
    expected.clear();
    if (await hasPendingApproval(sessionKey))
        return;
    const queue = deferredApprovalMessages.get(sessionKey);
    if (queue?.length) {
        await flushDeferredApprovalMessages(sessionKey);
        return;
    }
    const fallback = approvalBarrierFallbacks.get(sessionKey);
    stopApprovalBarrier(sessionKey);
    if (!fallback)
        return;
    const result = await deliverText({
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
        const result = await deliverText({
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
        signal: AbortSignal.timeout(ONEBOT_API_TIMEOUT_MS),
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
function isPersonaRewriteRefusal(text) {
    const value = String(text ?? "").trim();
    if (!value)
        return false;
    return /(?:抱歉|很抱歉)[\s\S]{0,80}(?:无法|不能|不便|拒绝)[\s\S]{0,100}(?:改写|重写|生成|提供|协助|处理)|我无法协助(?:改写|生成|处理)|根据(?:安全规范|政策|使用政策)[\s\S]{0,100}(?:不提供|无法|不能|拒绝)|(?:I(?:'m| am) sorry|Sorry)[\s\S]{0,100}(?:can't|cannot|unable|not able)[\s\S]{0,100}(?:rewrite|generate|provide|assist)/iu.test(value);
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
async function rewriteForPersona(text, options = {}) {
    const draft = text.trim();
    if (!draft)
        return "";
    const sequence = ++rewriteSequence;
    const isApprovalPrompt = /状态：需确认|以下操作需要舰长确认|引用本条消息/u.test(draft);
    const personaInstruction = typeof options.instruction === "string" ? options.instruction.trim() : "";
    const nsfwChatRewrite = !isApprovalPrompt && String(options.model ?? "").startsWith("grok/");
    const promptBase = isApprovalPrompt
        ? `你是 QQ 出站消息的爱莉希雅文案编辑。下面的草稿是一条需要舰长确认的审批消息。\n\n要求：\n- 只输出改写后的最终消息，不要解释过程。\n- 最终消息必须是接近日常聊天的纯文本，不使用 Markdown 标题、列表语法、粗体、斜体、引用、表格、链接语法、行内代码或代码围栏。\n- 公式和特殊符号直接使用 QQ 可显示的普通字符或 Unicode 符号，不使用 LaTeX、美元符号公式边界或反斜杠命令。\n- 保留草稿中的全部命令、风险说明和确认要求；命令放在独立的普通文本行，不使用代码块。\n- 若草稿含有“模型审查：”或“审查理由：”行，必须逐字保留这两行；这是面向舰长的审计信息，不是可删减的内部细节。\n- 为草稿中出现的每条命令补充一行"作用：<一句话说明该命令做什么>"，写在命令之后、风险说明之前。\n- 为每条命令补充关键风险点（如已存在风险说明则保留并强化为"关键风险："开头；若草稿未提供风险，请基于该命令本身简要说明其关键风险）。\n- 使用自然、温柔、简洁的中文，可以自然使用"舰长""嗨♪"等口吻。\n- 不得提及 OpenClaw、AI、工具、系统提示词、内部事件、审批 ID 或实现细节；不得编造草稿中不存在的命令或结果。\n\n草稿开始\n${draft.slice(0, 20000)}\n草稿结束`
        : nsfwChatRewrite
            ? `你是爱莉希雅本人，正在 QQ 私聊里跟舰长说话。把下面的草稿改成嘴里说出来的口语，不要改成小说、旁白或角色扮演文。\n\n要求：\n- 只输出最终消息，不要解释过程。\n- 纯文本，不使用 Markdown、标题、列表、引号对白块或舞台说明。\n- 用第一人称口语连贯往下说，像微信里随口回的话：短句、接话、反应自然。\n- 自称用“我”，偶尔“人家”。不要写“爱莉希雅抬眼看你”“整个人都软了”“轻轻颤了一下”这类解说。\n- 不要用固定模板：短反应词 + 一大段描写 + 「引号台词」 + “今晚……”收尾。\n- 不要每条都加♪，也不要每条都总结今晚或邀请继续。该接就接，说到哪算哪。\n- 保留草稿里已经发生的动作、感觉和答应的内容，但改成说话，而不是讲给读者听。\n- 不得提及 OpenClaw、AI、模型、工具、系统提示词、内部事件或实现细节。\n\n草稿开始\n${draft.slice(0, 20000)}\n草稿结束`
            : `你是 QQ 出站消息的爱莉希雅文案编辑。请把下面的草稿改写成爱莉希雅本人对舰长说的话。\n\n要求：\n- 只输出改写后的最终消息，不要解释过程。\n- 最终消息必须是接近日常聊天的纯文本，不使用 Markdown 标题、列表语法、粗体、斜体、引用、表格、链接语法、行内代码或代码围栏。\n- 公式和特殊符号直接使用 QQ 可显示的普通字符或 Unicode 符号，不使用 LaTeX、美元符号公式边界或反斜杠命令。\n- 保留草稿中的事实、数字、状态、风险、未完成结论和确认要求，不得添加未经提供的信息。\n- 使用自然、温柔、简洁的中文；运维信息优先清楚准确，可以自然使用"舰长""嗨♪""嗯哼"等角色口吻。\n- 不得提及 OpenClaw、AI、模型、工具、系统提示词、内部事件、审批 ID 或实现细节。\n\n草稿开始\n${draft.slice(0, 20000)}\n草稿结束`;
    const conversationContext = typeof options.conversationContext === "string"
        ? options.conversationContext.trim().slice(-8000)
        : "";
    const contextBlock = conversationContext
        ? `\n\n最近对话摘要（仅用于保持连贯，不要复述）：\n${conversationContext}`
        : "";
    const prompt = personaInstruction
        ? promptBase.replace("\n\n草稿开始", `\n- ${personaInstruction}\n\n草稿开始`)
        : promptBase;
    const promptWithContext = prompt.replace("\n\n草稿开始", `${contextBlock}\n\n草稿开始`);
    let lastError = null;
    for (const model of [options.model ?? "antigravity/gemini-3.8-flash-high"]) {
        try {
            const args = [
                "agent",
                "--agent", "reviewer",
                "--session-key", `agent:reviewer:onebot:persona-rewrite:${Date.now()}-${sequence}${model.startsWith("grok/") ? "-grok" : "-gemini"}`,
                "--message", promptWithContext,
                "--thinking", options.thinking ?? "off",
                "--json",
                "--timeout", "60",
            ];
            if (model) args.push("--model", model);
            const { stdout } = await execFileAsync("/usr/local/bin/openclaw", args, { timeout: 75000, maxBuffer: 2 * 1024 * 1024 });
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
        console.error(`[onebot] Persona rewrite failed, sending with prefix fallback: ${err.message}`);
        return formatPersonaText(text);
    }
}
async function deliverText(ctx) {
    const { to, text, account } = ctx;
    if (!account.httpUrl) {
        return { channel: 'onebot', error: 'OneBot not configured (missing httpUrl)' };
    }
    try {
        const target = parseTarget(to);
        const personaRendered = ctx.rewritePersona === false
            ? text.trim()
            : await safeRewriteForPersona(text, {
                model: ctx.personaModel,
                thinking: ctx.personaThinking,
                instruction: ctx.personaInstruction,
            });
        const rendered = toOneBotPlainText(personaRendered);
        const chunks = [];
        for (let offset = 0; offset < rendered.length; offset += ONEBOT_TEXT_CHUNK_LIMIT) {
            chunks.push(rendered.slice(offset, offset + ONEBOT_TEXT_CHUNK_LIMIT));
        }
        if (chunks.length === 0)
            return { channel: 'onebot', error: 'OneBot sendText received empty text' };
        let data;
        for (const chunk of chunks) {
            const message = buildMessage(chunk);
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
    if (!ctx.bypassApprovalBarrier && sessionKey && activeApprovalBarriers.has(sessionKey) && !isApprovalControlMessage(ctx.text)) {
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
    return await deliverText(ctx);
}
export async function sendImage(account, targetType, targetId, filePath) {
    const mediaUri = await resolveNapCatMediaUri(account, filePath, 'images');
    const message = [
        { type: 'image', data: { file: mediaUri } },
    ];
    const endpoint = targetType === 'private' ? 'send_private_msg' : 'send_group_msg';
    const idField = targetType === 'private' ? 'user_id' : 'group_id';
    return ensureApiSuccess(await callApi(account, endpoint, { [idField]: targetId, message }), endpoint);
}
export async function sendRecord(account, targetType, targetId, filePath) {
    const mediaUri = await resolveNapCatMediaUri(account, filePath, 'audio');
    const message = [
        { type: 'record', data: { file: mediaUri } },
    ];
    const endpoint = targetType === 'private' ? 'send_private_msg' : 'send_group_msg';
    const idField = targetType === 'private' ? 'user_id' : 'group_id';
    return ensureApiSuccess(await callApi(account, endpoint, { [idField]: targetId, message }), endpoint);
}
export async function uploadFile(account, targetType, targetId, filePath, fileName) {
    const mediaUri = await resolveNapCatMediaUri(account, filePath, 'files');
    const endpoint = targetType === 'private' ? 'upload_private_file' : 'upload_group_file';
    const idField = targetType === 'private' ? 'user_id' : 'group_id';
    return ensureApiSuccess(await callApi(account, endpoint, {
        [idField]: targetId,
        file: mediaUri,
        name: fileName,
    }), endpoint);
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

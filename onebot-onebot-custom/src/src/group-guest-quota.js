import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const GROUP_GUEST_QUOTA_SCRIPT = "/root/.openclaw/workspace/skills/agy-proxy/scripts/agy-proxy-diagnose.sh";
const inFlight = new Map();
export const QUOTA_FOCUS_MODELS = Object.freeze([
    'gemini-3.1-flash-image', 'gemini-3.8-flash-high', 'claude-opus-5-5-low',
]);
const quotaFamily = model => model.startsWith('gemini-') ? 'gemini' : '3p';

// Intent comes from the shared inbound LLM pass. Routing facts come from the
// actual OneBot event. Neither raw user text nor a model string becomes argv.
export function resolveGroupQuotaAction({ isGroup, peerFollowup, explicit, roleCount, intent }) {
    if (!isGroup || peerFollowup || !explicit || roleCount !== 1)
        return null;
    if (intent?.imageGeneration || intent?.xiaohongshuOperation || intent?.xOperation || intent?.speechMode === 'literal'
        || ['create','list','cancel'].includes(intent?.reminderAction))
        return null;
    return intent?.quotaAction === 'refresh' ? 'refresh' : intent?.quotaAction === 'query' ? 'quota' : null;
}

function resetLabel(value) {
    if (value === "unknown")
        return "未知";
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value))
        return "未知";
    const date = new Date(value);
    if (Number.isNaN(date.getTime()))
        return "未知";
    return `${new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date)}（北京时间）`;
}

export function formatGroupGuestQuotaResult(action, stdout) {
    const lines = String(stdout ?? "").split(/\r?\n/u);
    const counters = {};
    const states = new Map();
    const models = [];
    const buckets = new Map();
    for (const line of lines) {
        const counter = /^(refresh_http|refresh_total|refresh_success|refresh_failed|account_count)=(\d+)$/u.exec(line);
        if (counter)
            counters[counter[1]] = Number(counter[2]);
        const state = /^account_(\d+) forbidden=(true|false) disabled=(true|false) /u.exec(line);
        if (state)
            states.set(state[1], state[2] === "true" || state[3] === "true");
        const model = /^account_(\d+) model=([a-z0-9][a-z0-9._-]{0,127}) remaining=(\d+(?:\.\d+)?)% reset=(\S+)$/iu.exec(line);
        const bucket = /^account_(\d+) quota_group=.+ bucket=(gemini|3p)-(5h|weekly) remaining=(\d+(?:\.\d+)?)% reset=(\S+)$/u.exec(line);
        if (bucket && Number(bucket[4]) <= 100)
            buckets.set(bucket[1] + ':' + bucket[2] + ':' + bucket[3], { percentage: bucket[4], reset: resetLabel(bucket[5]) });
        if (!model || Number(model[3]) > 100 || !QUOTA_FOCUS_MODELS.includes(model[2]))
            continue;
        models.push({ account: model[1], model: model[2], percentage: model[3], reset: resetLabel(model[4]) });
    }
    let heading = "我查到的剩余额度如下（缓存数据）：";
    if (action === "refresh") {
        if (!(counters.refresh_http >= 200 && counters.refresh_http < 300)
            || !Number.isSafeInteger(counters.refresh_total)
            || !Number.isSafeInteger(counters.refresh_success)
            || !Number.isSafeInteger(counters.refresh_failed)
            || counters.refresh_total !== counters.refresh_success + counters.refresh_failed)
            return "这次没能完成额度刷新，暂时无法确认最新的剩余额度，请稍后再试。";
        if (counters.refresh_total === 0)
            return "目前没有可刷新的额度数据。";
        heading = counters.refresh_failed > 0
            ? `额度刷新成功 ${counters.refresh_success} 项，失败 ${counters.refresh_failed} 项；未刷新成功的数据可能仍是缓存：`
            : "额度已刷新，当前剩余额度如下：";
    }
    if (models.length === 0)
        return action === "refresh" ? `${heading}\n暂时没有可用的模型额度明细。` : "这次没能查到可用的模型额度明细，请稍后再试。";
    // Copy only known quota fields; never forward arbitrary script output,
    // account identities, credentials, errors or provider response bodies.
    const accounts = [...new Set(models.map(item => item.account))].slice(0, 40);
    const output = [];
    for (const account of accounts) {
        if (accounts.length > 1 || states.get(account))
            output.push('账户' + account + (states.get(account) ? '（账户不可用）' : ''));
        for (const model of QUOTA_FOCUS_MODELS) {
            const present = models.some(item => item.account === account && item.model === model);
            output.push(model + (present ? '：' : '（上游未返回该模型明细）：'));
            for (const [window, label] of [['5h', '5小时配额'], ['weekly', '周配额']]) {
                // Model-level percentage is an effective aggregate, not a 5h or
                // weekly bucket. Never substitute it for a missing window.
                const bucket = present ? buckets.get(account + ':' + quotaFamily(model) + ':' + window) : undefined;
                output.push(bucket ? label + '：剩余 ' + bucket.percentage + '%，重置 ' + bucket.reset
                    : label + '：未知（上游未返回）');
            }
        }
    }
    output.push('两项 Gemini 共用 Gemini 配额组；Claude 使用 Claude/GPT 配额组。');
    return `${heading}\n${output.join("\n")}`;
}

export async function runGroupGuestQuotaAction(action, execute = execFileAsync, options = {}) {
    if (action !== "quota" && action !== "refresh")
        throw new Error("Unsupported guest quota action");
    const shared = execute === execFileAsync && !options.signal;
    const key = `${action}:${options.timeoutMs ?? 'default'}`;
    if (shared && inFlight.has(key))
        return inFlight.get(key);
    const run = (async () => {
        try {
            const { stdout } = await execute(GROUP_GUEST_QUOTA_SCRIPT, [action], {
                timeout: options.timeoutMs ?? (action === "refresh" ? 255000 : 75000),
                ...(options.signal ? { signal: options.signal } : {}),
                maxBuffer: 1024 * 1024,
            });
            return formatGroupGuestQuotaResult(action, stdout);
        }
        catch {
            return action === "refresh"
                ? "这次额度刷新未能完成，暂时无法确认最新的剩余额度，请稍后再试。"
                : "这次没能查询到剩余额度，请稍后再试。";
        }
    })();
    if (!shared)
        return run;
    inFlight.set(key, run);
    try {
        return await run;
    }
    finally {
        inFlight.delete(key);
    }
}

// These checks only validate the complete model response. They never render,
// append, repair or replace a factual portion of the final reply.
export function validateQuotaPersonaReply(facts, candidate) {
    if (typeof candidate !== 'string' || !candidate.trim() || candidate.length > 20000
        || /(?:sk|rk)-[A-Za-z0-9_-]{12,}|https?:|\/(?:root|etc|proc)\/|\[CQ:|MEDIA:|<think/iu.test(candidate)) return false;
    const compact = value => value.replace(/\s+/gu, '');
    const original = compact(facts), reply = compact(candidate);
    const ids = value => [...value.matchAll(/(?:gemini|claude)-[a-z0-9._-]+/gu)].map(m => m[0]);
    if (JSON.stringify(ids(original)) !== JSON.stringify(ids(reply))) return false;
    const sections = value => value.split(/((?:gemini|claude)-[a-z0-9._-]+)/gu);
    const a = sections(original), b = sections(reply);
    if (a.length !== b.length) return false;
    for (let n = 2; n < a.length; n += 2) {
        const values = value => ({
            percentages: [...value.matchAll(/\d+(?:\.\d+)?%/gu)].map(m => m[0]),
            resets: [...value.matchAll(/\d{2}\/\d{2}\d{2}:\d{2}/gu)].map(m => m[0]),
            windows: [...value.matchAll(/5小时配额|周配额/gu)].map(m => m[0]),
            unknown: (value.match(/未知/gu) ?? []).length,
        });
        const factualWindows = value => {
            const parts = value.split(/(5小时配额|周配额)/gu), result = [];
            for (let i = 1; i < parts.length; i += 2) {
                const facts = values(parts[i + 1]);
                // A closing remark may mention a window again without asserting
                // another amount/reset. Compare only the factual window records.
                if (facts.percentages.length || facts.resets.length || facts.unknown)
                    result.push({ window: parts[i], ...facts });
            }
            return result;
        };
        if (JSON.stringify(factualWindows(a[n])) !== JSON.stringify(factualWindows(b[n]))) return false;
    }
    const numbers = value => [...value.replace(/(?:gemini|claude)-[a-z0-9._-]+/gu, '').replace(/5小时配额|周配额/gu, '').matchAll(/\d+(?:\.\d+)?/gu)].map(m => m[0]);
    if (JSON.stringify(numbers(original)) !== JSON.stringify(numbers(reply))) return false;
    for (const status of ['缓存', '账户不可用', '未返回该模型明细'])
        if (original.includes(status) && !reply.includes(status)) return false;
    if (original.includes('额度已刷新') && !/已刷新|刷新完成|刷新好|刷新成功/u.test(reply)) return false;
    if (/没能|未能|暂时无法|失败/u.test(original) && !/没能|未能|暂时无法|失败/u.test(reply)) return false;
    if (!ids(original).length && /%|已刷新|刷新完成|刷新成功/u.test(reply)) return false;
    if (ids(original).length && !/共用|共享/u.test(reply)) return false;
    if (original.includes('北京时间') && !reply.includes('北京时间')) return false;
    if (original.includes('未开放') && !reply.includes('未开放')) return false;
    return true;
}

export async function prepareQuotaPersonaReply(facts, { rewrite, signal } = {}) {
    if (typeof rewrite !== 'function') throw new Error('Quota persona generator is required');
    for (let attempt = 0; attempt < 2; attempt++) {
        signal?.throwIfAborted();
        try {
            const candidate = await rewrite(facts, attempt);
            signal?.throwIfAborted();
            if (validateQuotaPersonaReply(facts, candidate)) return candidate.trim();
        } catch { signal?.throwIfAborted(); }
    }
    // Never deliver raw facts as a successful reply when all generation fails.
    // A model may instead generate a short, truthful failure notice in full.
    signal?.throwIfAborted();
    const failure = '额度取数流程已结束，但本次完整额度回复生成或校验未能完成，暂时无法提供可靠的额度总结。';
    const candidate = await rewrite(failure, 2);
    signal?.throwIfAborted();
    if (validateQuotaPersonaReply(failure, candidate)) return candidate.trim();
    throw new Error('Quota persona generation failed validation');
}

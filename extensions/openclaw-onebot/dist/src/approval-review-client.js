import { onebotPath } from "./paths.js";
import http from "node:http";
import https from "node:https";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Approval requests contain evidence, never executable agent instructions. Use
// bounded, non-streaming API calls without agent sessions, tools or workspace data.
export function parseApprovalReview(text) {
    const value = String(text ?? "").trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1");
    try {
        const result = JSON.parse(value);
        if (!["allow", "ask"].includes(result?.decision)
            || typeof result.purpose !== "string" || !result.purpose.trim()
            || typeof result.rationale !== "string" || !result.rationale.trim())
            return undefined;
        return { decision: result.decision, purpose: result.purpose.trim().slice(0, 500), rationale: result.rationale.trim().slice(0, 1000) };
    }
    catch { return undefined; }
}

function failure(code, retryable = false) {
    return Object.assign(new Error(code), { code, retryable });
}

function httpFailure(status, payload) {
    const message = String(payload?.error?.message ?? "");
    if (status === 404)
        return failure("HTTP 404：当前凭证分组不支持该模型");
    if (status === 401)
        return failure("HTTP 401：API 凭证未通过认证");
    if (status === 403)
        return failure(/Codex|客户端|client/i.test(message)
            ? "HTTP 403：上游限制客户端类型，不能用于此审批调用"
            : "HTTP 403：当前凭证没有模型访问权限");
    if (status === 429)
        return failure("HTTP 429：上游额度不足或限流");
    return failure(`HTTP ${status}：上游请求失败`, status === 408 || status >= 500);
}

export function requestApprovalJson(url, { apiKey, body, timeoutMs, signal }) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let request;
        let response;
        let onAbort;
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            if (error) {
                response?.destroy();
                request?.destroy();
                reject(error);
            }
            else resolve(value);
        };
        const timer = setTimeout(() => finish(failure("审批 API 请求超时", true)), timeoutMs);
        onAbort = () => finish(signal.reason ?? failure("审批 API 已取消"));
        signal?.addEventListener("abort", onAbort, {once:true});
        if (signal?.aborted) { onAbort(); return; }
        try {
            const target = new URL(url);
            if (!["http:", "https:"].includes(target.protocol) || target.username || target.password)
                throw failure("审批 API 地址配置无效");
            const data = JSON.stringify(body);
            request = (target.protocol === "https:" ? https : http).request(target, {
                method: "POST",
                headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json", "Content-Length": Buffer.byteLength(data) },
            }, (res) => {
                response = res;
                const chunks = [];
                let bytes = 0;
                res.on("data", (chunk) => {
                    bytes += chunk.length;
                    if (bytes > 2 * 1024 * 1024) finish(failure("审批 API 响应超过大小限制"));
                    else chunks.push(chunk);
                });
                res.on("error", () => finish(failure("审批 API 响应中断", true)));
                res.on("aborted", () => finish(failure("审批 API 响应中断", true)));
                res.on("end", () => {
                    let payload;
                    try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
                    catch {
                        return finish(res.statusCode >= 200 && res.statusCode < 300
                            ? failure("审批 API 返回非 JSON 响应", true)
                            : httpFailure(res.statusCode, {}));
                    }
                    if (res.statusCode < 200 || res.statusCode >= 300)
                        return finish(httpFailure(res.statusCode, payload));
                    finish(null, payload);
                });
            });
            request.on("error", () => finish(failure("审批 API 网络请求失败", true)));
            request.end(data);
        }
        catch { finish(failure("审批 API 地址或请求配置无效")); }
    });
}

export function createApprovalReviewers({
    configPath = onebotPath("openclaw.json"),
    read = readFile,
    request = requestApprovalJson,
} = {}) {
    async function review({ providerId, model, effort, prompt, timeoutMs, signal }) {
        signal?.throwIfAborted();
        let provider, apiKey;
        try {
            const config = JSON.parse(await read(configPath, "utf8"));
            provider = config.models?.providers?.[providerId];
            if (!provider?.models?.some((entry) => entry.id === model)) throw new Error();
            const ref = provider.apiKey;
            if (typeof ref === "string") apiKey = ref.trim();
            else if (ref?.source === "file") {
                const source = config.secrets?.providers?.[ref.provider];
                if (source?.mode !== "singleValue" || ref.id !== "value") throw new Error();
                apiKey = String(await read(source.path, "utf8")).trim();
            }
            else if (ref?.source === "env") apiKey = process.env[ref.id]?.trim();
            if (!apiKey) throw new Error();
        }
        catch { throw failure(`${providerId} 审批模型或凭证配置无法读取`); }
        const responses = provider.api === "openai-responses";
        const url = `${String(provider.baseUrl).replace(/\/$/, "")}/${responses ? "responses" : "chat/completions"}`;
        const body = responses ? {
            model, input: prompt, reasoning: { effort }, max_output_tokens: 4096, stream: false, store: false,
        } : {
            model,
            messages: [
                { role: "system", content: "你是命令风险分类器。只分析提供的命令，不执行任何命令，不使用工具。按给定策略独立判断，输出包含 decision、purpose、rationale 的 JSON 对象。" },
                { role: "user", content: prompt },
            ],
            reasoning_effort: effort, max_tokens: 2048, temperature: 0, stream: false,
        };
        const result = await request(url, { apiKey, body, timeoutMs, ...(signal ? {signal} : {}) });
        let text;
        if (responses) {
            if (result.status !== "completed") throw failure("审批 API 未返回完整结论", true);
            text = (result.output ?? []).filter((item) => item.type === "message")
                .flatMap((item) => item.content ?? []).filter((part) => part.type === "output_text")
                .map((part) => part.text ?? "").join("");
        }
        else {
            const choice = result.choices?.[0];
            if (choice?.finish_reason !== "stop" || choice.message?.tool_calls?.length)
                throw failure("审批 API 未返回完整结论", true);
            text = choice.message?.content;
        }
        const parsed = parseApprovalReview(text);
        if (!parsed) throw failure("审批 API 未返回有效判断 JSON", true);
        return parsed;
    }

    return {
        async gpt(prompt, {signal} = {}) {
            const errors = [];
            for (const [model, effort] of [["gpt-6-luna", "max"], ["gpt-6-sol", "high"]]) {
                try {
                    const result = await review({ providerId: "novacode-gpt", model, effort, prompt, signal, timeoutMs: 30000 });
                    return { ...result, model, fallback: model === "gpt-6-sol" };
                }
                catch (err) { signal?.throwIfAborted(); errors.push(`${model}：${err.message}`); }
            }
            throw failure(errors.join("；"));
        },
        async grok(prompt, {signal} = {}) {
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    const result = await review({ providerId: "grok", model: "grok-4.7", effort: "low", prompt, signal, timeoutMs: attempt === 0 ? 25000 : 20000 });
                    return { ...result, model: "grok-4.7", retried: attempt > 0 };
                }
                catch (err) { signal?.throwIfAborted(); if (!err.retryable || attempt === 1) throw err; }
            }
        },
    };
}

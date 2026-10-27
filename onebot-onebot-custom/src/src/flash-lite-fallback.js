import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { onebotPath } from './paths.js';
import { loadModelRouting } from './model-routing.js';
import { requestApprovalJson } from './approval-review-client.js';
import { resolveProviderCredential } from './llm-credentials.js';

export const OFFICIAL_FLASH_LITE = 'gemini-official/gemini-3.5-flash-lite';
export const isFlashLite = route => /^gemini-[a-z0-9.-]*flash-lite$/u.test(String(route?.model ?? route).split('/').at(-1));
export function flashLiteRoutes(primary, routing = loadModelRouting()) {
    if (!isFlashLite(primary)) return [primary];
    return [primary, ...(routing.flashLiteFallbacks ?? [{ model: OFFICIAL_FLASH_LITE, thinking: 'off' }, ...(routing.errorFallbacks ?? [])])]
        .filter((route, i, all) => all.findIndex(other => other.model === route.model) === i);
}
export async function withFlashLiteFallback(primary, invoke, { routing, signal, log } = {}) {
    let last;
    for (const route of flashLiteRoutes(primary, routing)) {
        signal?.throwIfAborted();
        try { return await invoke(route); }
        catch (error) {
            signal?.throwIfAborted(); last = error;
            const code = /HTTP\s+(\d{3})/u.exec(String(error?.code ?? error?.message ?? ''))?.[1];
            log?.warn?.(`[onebot] Flash Lite attempt unavailable model=${route.model} reason=${code ? 'http-' + code : 'transport-or-response'}; trying next configured model`);
        }
    }
    throw last ?? new Error('Flash Lite chain unavailable');
}

// The official Google endpoint requires the existing local egress proxy on this
// host. Credentials and JSON are passed via environment/stdin, never argv/logs.
export function requestOfficialGeminiJson(url, { apiKey, body, timeoutMs, signal, proxyUrl = 'http://127.0.0.1:7890', execute = execFile }) {
    if (new URL(url).hostname !== 'generativelanguage.googleapis.com') throw new Error('Invalid official Gemini host');
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        const script = 'exec /usr/bin/curl -q -sS --proxy "$ONEBOT_OFFICIAL_PROXY" --connect-timeout 10 --max-time "$ONEBOT_OFFICIAL_TIMEOUT" -H @/dev/fd/3 "$ONEBOT_OFFICIAL_URL" --data-binary @- -w "\\n%{http_code}" 3<<ONEBOT_HEADERS\nAuthorization: Bearer $ONEBOT_OFFICIAL_KEY\nContent-Type: application/json\nAccept: application/json\nONEBOT_HEADERS\n';
        const child = execute('/bin/sh', ['-c', script], {
            timeout: timeoutMs + 1000, ...(signal ? { signal } : {}), maxBuffer: 2 * 1024 * 1024,
            env: { ...process.env, ONEBOT_OFFICIAL_PROXY: proxyUrl, ONEBOT_OFFICIAL_TIMEOUT: String(Math.max(1, Math.ceil(timeoutMs / 1000))), ONEBOT_OFFICIAL_KEY: apiKey, ONEBOT_OFFICIAL_URL: url },
        }, (error, stdout) => {
            if (error) return reject(new Error(signal?.aborted ? 'Official Gemini cancelled' : 'Official Gemini transport unavailable'));
            const split = stdout.lastIndexOf('\n'), status = Number(stdout.slice(split + 1));
            if (status < 200 || status >= 300) return reject(Object.assign(new Error(`HTTP ${status}: official Gemini request failed`), { code: `HTTP ${status}` }));
            try { resolve(JSON.parse(stdout.slice(0, split))); }
            catch { reject(new Error('Official Gemini invalid JSON')); }
        });
        child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(body));
    });
}
export function compatibleChatBody(config, route, body) {
    const [providerId, model] = route.model.split('/');
    const provider = config.models?.providers?.[providerId];
    const compat = provider?.models?.find(item => item.id === model)?.compat ?? {};
    const value = { ...body, model, stream: false };
    if (compat.supportsReasoningEffort === false) delete value.reasoning_effort;
    else {
        const supported = compat.supportedReasoningEfforts;
        value.reasoning_effort = supported?.length && !supported.includes(route.thinking ?? 'off') ? supported[0] : route.thinking ?? 'off';
    }
    return value;
}
export async function callConfiguredChat(route, body, {
    config, readConfig = async () => JSON.parse(await readFile(onebotPath('openclaw.json'), 'utf8')),
    getCredential = resolveProviderCredential, request = requestApprovalJson,
    officialRequest = requestOfficialGeminiJson, signal, timeoutMs = 30000, proxyUrl,
} = {}) {
    config ??= await readConfig();
    const [providerId] = route.model.split('/'), provider = config.models?.providers?.[providerId];
    if (!provider?.baseUrl) throw new Error('Model provider unavailable');
    const apiKey = await getCredential(config, provider); signal?.throwIfAborted();
    if (!apiKey) throw new Error('Model credential unavailable');
    const invoke = providerId === 'gemini-official' && request === requestApprovalJson ? officialRequest : request;
    return invoke(provider.baseUrl.replace(/\/$/u, '') + '/chat/completions', {
        apiKey, body: compatibleChatBody(config, route, body), timeoutMs, signal, ...(proxyUrl ? { proxyUrl } : {}),
    });
}
export function completionText(result) {
    const choice = result?.choices?.[0];
    if (choice?.finish_reason !== 'stop' || choice.message?.tool_calls?.length || typeof choice.message?.content !== 'string')
        throw new Error('Incomplete model response');
    return choice.message.content;
}

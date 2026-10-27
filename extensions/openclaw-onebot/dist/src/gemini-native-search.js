export const GEMINI_NATIVE_SEARCH_MARKER = "[[OPENCLAW_ANTIGRAVITY_WEB_SEARCH_REQUIRED]]";
const SEARCH_INSTRUCTION = "请使用 Gemini 内置 Google Search grounding 联网核实，给出可核查的来源链接；搜索由服务端执行，不要要求客户端调用 web_search 或其他本地搜索函数。没有检索到资料时明确说明未核实，不要编造官方公告。";

function containsMarker(value) {
    if (typeof value === "string") return value.includes(GEMINI_NATIVE_SEARCH_MARKER);
    if (Array.isArray(value)) return value.some(containsMarker);
    if (!value || typeof value !== "object") return false;
    return containsMarker(value.content) || containsMarker(value.text);
}

export function requiresGeminiNativeSearch(model, context, options) {
    if (String(model?.provider ?? "").trim().toLowerCase() !== "antigravity"
        || !String(model?.id ?? "").trim().toLowerCase().startsWith("gemini-")) return false;
    if (options?.openclawGeminiWebSearch === true) return true;
    const messages = Array.isArray(context?.messages) ? context.messages : [];
    // Current core appends a separate generated user-role context message.
    // Skip that envelope, while still stopping at the latest actual user turn.
    const runtimeEnvelope = message => {
        const content = typeof message?.content === 'string' ? message.content
            : Array.isArray(message?.content) ? message.content.map(part => part?.text ?? '').join('\n') : '';
        return content.startsWith('OpenClaw runtime context for the immediately preceding user message.')
            && content.includes('<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>') && content.includes('<<<END_OPENCLAW_INTERNAL_CONTEXT>>>');
    };
    const latestUser = messages.findLast((message) => message?.role === "user" && !runtimeEnvelope(message));
    return containsMarker(latestUser);
}

export function patchGeminiNativeSearchPayload(payload) {
    if (!payload || typeof payload !== "object") return;
    // Antigravity recognizes this native declaration and injects googleSearch.
    // A function named web_search becomes functionDeclarations and suppresses
    // grounding in current proxy versions. No local executor is involved here.
    payload.tools = [{ googleSearch: {} }];
    delete payload.tool_choice;
    delete payload.parallel_tool_calls;
    if (!Array.isArray(payload.messages)) return;
    for (const message of payload.messages) {
        if (typeof message.content === "string") {
            message.content = message.content.replaceAll(GEMINI_NATIVE_SEARCH_MARKER, "").trim();
        } else if (Array.isArray(message.content)) {
            for (const part of message.content) {
                if (typeof part?.text === "string") part.text = part.text.replaceAll(GEMINI_NATIVE_SEARCH_MARKER, "").trim();
            }
        }
    }
    const latestUser = payload.messages.findLast((message) => message?.role === "user");
    if (!latestUser) return;
    if (typeof latestUser.content === "string") {
        if (!latestUser.content.includes(SEARCH_INSTRUCTION)) latestUser.content += `\n${SEARCH_INSTRUCTION}`;
    } else if (Array.isArray(latestUser.content)
        && !latestUser.content.some((part) => part?.text?.includes(SEARCH_INSTRUCTION))) {
        latestUser.content.push({ type: "text", text: SEARCH_INSTRUCTION });
    }
}

export function withGeminiNativeSearch(model, context, options) {
    if (!requiresGeminiNativeSearch(model, context, options)) return options;
    const originalOnPayload = options?.onPayload;
    return { ...options, onPayload(payload, actualModel) {
        const result = originalOnPayload?.(payload, actualModel ?? model);
        // Apply after other request modifiers so stale function/forced-choice
        // compatibility wrappers cannot turn grounding back into a local call.
        if (result && typeof result.then === "function") return result.then((replacement) => {
            patchGeminiNativeSearchPayload(payload);
            if (replacement && replacement !== payload && typeof replacement === "object") patchGeminiNativeSearchPayload(replacement);
            return replacement;
        });
        patchGeminiNativeSearchPayload(payload);
        if (result && result !== payload && typeof result === "object") patchGeminiNativeSearchPayload(result);
        return result;
    } };
}

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { GEMINI_NATIVE_SEARCH_MARKER as marker, requiresGeminiNativeSearch, patchGeminiNativeSearchPayload, withGeminiNativeSearch } from "../src/src/gemini-native-search.js";

const gemini = { provider: "antigravity", id: "gemini-3.8-flash-high" };
const context = { messages: [{ role: "user", content: `${marker}\n查一下官方公告` }] };

test("native search is scoped to local Gemini and the latest user turn", () => {
    assert.equal(requiresGeminiNativeSearch(gemini, context), true);
    assert.equal(requiresGeminiNativeSearch({ provider: "grok", id: "grok-4.7" }, context), false);
    assert.equal(requiresGeminiNativeSearch({ provider: "novacode", id: "qwen" }, context, { openclawGeminiWebSearch: true }), false);
    assert.equal(requiresGeminiNativeSearch(gemini, { messages: [...context.messages, { role: "assistant", content: "done" }, { role: "user", content: "你好" }] }), false);
    assert.equal(requiresGeminiNativeSearch(gemini, { messages: [] }, { openclawGeminiWebSearch: true }), true);
    assert.equal(requiresGeminiNativeSearch(gemini, { messages: [{ role: "user", content: [{ type: "text", text: marker }] }] }), true);
});

test('generated runtime user envelope does not mask the current search marker or revive an older one', () => {
    const envelope = { role: 'user', content: [{ type: 'text', text: 'OpenClaw runtime context for the immediately preceding user message.\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n{}\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>' }] };
    assert.equal(requiresGeminiNativeSearch(gemini, { messages: [...context.messages, envelope] }), true);
    assert.equal(requiresGeminiNativeSearch(gemini, { messages: [...context.messages, { role: 'assistant', content: 'done' }, { role: 'user', content: '你好' }, envelope] }), false);
});

test("native payload removes forced local function and retains native grounding declaration only", () => {
    const payload = { tools: [{ type: "function", function: { name: "web_search" } }], tool_choice: { type: "function", function: { name: "web_search" } }, parallel_tool_calls: false,
        messages: [{ role: "user", content: `${marker}\nSearch now` }] };
    patchGeminiNativeSearchPayload(payload);
    assert.deepEqual(payload.tools, [{ googleSearch: {} }]);
    assert.equal(payload.tool_choice, undefined);
    assert.equal(payload.parallel_tool_calls, undefined);
    assert.doesNotMatch(payload.messages[0].content, /OPENCLAW_ANTIGRAVITY/);
    assert.match(payload.messages[0].content, /服务端执行/);
    assert.match(payload.messages[0].content, /可核查的来源/);
    const once = structuredClone(payload);
    patchGeminiNativeSearchPayload(payload);
    assert.deepEqual(payload, once);
});

test("native modifier applies after stale callbacks, including async replacement payload", async () => {
    const options = { temperature: 0, onPayload(payload) { payload.tools = [{ type: "function", function: { name: "web_search" } }]; payload.tool_choice = "required"; } };
    const patched = withGeminiNativeSearch(gemini, context, options);
    const payload = { messages: [{ role: "user", content: [{ type: "text", text: marker }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }] };
    patched.onPayload(payload);
    assert.deepEqual(payload.tools, [{ googleSearch: {} }]);
    assert.equal(payload.tool_choice, undefined);
    assert.equal(payload.messages[0].content[1].image_url.url, "data:image/png;base64,AAAA");
    const asyncOptions = withGeminiNativeSearch(gemini, context, { onPayload: async () => ({ tool_choice: "required", messages: [] }) });
    const replacement = await asyncOptions.onPayload({});
    assert.deepEqual(replacement.tools, [{ googleSearch: {} }]);
    assert.equal(replacement.tool_choice, undefined);
});

test("nonsearch and nonGemini request options are left intact", () => {
    const options = { onPayload() {}, tools: [{ name: "exec" }] };
    assert.equal(withGeminiNativeSearch(gemini, { messages: [{ role: "user", content: "hello" }] }, options), options);
    assert.equal(withGeminiNativeSearch({ provider: "grok", id: "grok-4.7" }, context, options), options);
});

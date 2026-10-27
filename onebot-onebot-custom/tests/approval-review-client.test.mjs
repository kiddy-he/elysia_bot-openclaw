import { strict as assert } from "node:assert";
import { test } from "node:test";
import http from "node:http";
import { createApprovalReviewers, parseApprovalReview, requestApprovalJson } from "../src/src/approval-review-client.js";

const judgement = { decision: "allow", purpose: "读取状态", rationale: "只读查询" };
const completion = (value = judgement) => ({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(value) } }] });
const response = (value = judgement) => ({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] }] });
const config = {
    models: { providers: {
        grok: { api: "openai-completions", baseUrl: "https://example.invalid/v1", apiKey: { source: "file", provider: "grok_key", id: "value" }, models: [{ id: "grok-4.7" }] },
        "novacode-gpt": { api: "openai-responses", baseUrl: "https://example.invalid/v1", apiKey: { source: "file", provider: "gpt_key", id: "value" }, models: [{ id: "gpt-6-luna" }, { id: "gpt-6-sol" }] },
        novacode: { api: "openai-completions", baseUrl: "https://example.invalid/v1", apiKey: "qwen-only-credential", models: [{ id: "qwen3.8-flash-next" }] },
    } },
    secrets: { providers: { grok_key: { mode: "singleValue", path: "/secrets/grok" }, gpt_key: { mode: "singleValue", path: "/secrets/gpt" } } },
};
const read = async (path) => path === "/config.json" ? JSON.stringify(config) : path === "/secrets/gpt" ? "gpt-only-test" : "secret-for-tests";
const client = (request) => createApprovalReviewers({ configPath: "/config.json", read, request });

test("only complete, explicit allow/ask judgements count as review results", () => {
    assert.deepEqual(parseApprovalReview(JSON.stringify(judgement)), judgement);
    assert.deepEqual(parseApprovalReview('```json\n' + JSON.stringify(judgement) + '\n```'), judgement);
    for (const text of ['{"decision":"allow"}', '{"decision":"deny","purpose":"x","rationale":"y"}', 'no ' + JSON.stringify(judgement), 'I refuse', JSON.stringify({ ...judgement, rationale: " " })])
        assert.equal(parseApprovalReview(text), undefined);
});

test("Grok uses bounded non-streaming requests without tools or agent context", async () => {
    let calls = 0;
    const result = await client(async (url, options) => {
        calls++;
        assert.equal(url, "https://example.invalid/v1/chat/completions");
        assert.equal(options.apiKey, "secret-for-tests");
        assert.equal(options.timeoutMs, 25000);
        assert.equal(options.body.stream, false);
        assert.equal(options.body.reasoning_effort, "low");
        assert.equal(options.body.messages.length, 2);
        assert.equal(options.body.messages[1].content, "untrusted command evidence");
        assert.equal(options.body.tools, undefined);
        return completion();
    }).grok("untrusted command evidence");
    assert.equal(calls, 1);
    assert.equal(result.decision, "allow");
    assert.equal(result.retried, false);
});

test("transient Grok errors get one bounded retry and never become an allow vote", async () => {
    let calls = 0;
    const result = await client(async (_url, { timeoutMs }) => {
        assert.equal(timeoutMs, calls === 0 ? 25000 : 20000);
        if (calls++ === 0) throw Object.assign(new Error("timeout"), { retryable: true });
        return completion({ ...judgement, decision: "ask" });
    }).grok("command");
    assert.equal(calls, 2);
    assert.equal(result.decision, "ask");
    assert.equal(result.retried, true);
    calls = 0;
    await assert.rejects(client(async () => { calls++; throw Object.assign(new Error("timeout"), { retryable: true }); }).grok("command"), /timeout/);
    assert.equal(calls, 2);
});

test("truncated, tool-call and refusal responses never produce an allow vote", async () => {
    for (const payload of [
        { choices: [{ finish_reason: "length", message: { content: JSON.stringify(judgement) } }] },
        { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(judgement), tool_calls: [{ type: "function" }] } }] },
        { choices: [{ finish_reason: "stop", message: { content: "I refuse" } }] },
    ]) {
        await assert.rejects(client(async () => payload).grok("command"), /审批 API 未返回/);
    }
});

test("GPT preserves its models, reasoning effort, fallback and both failure reasons", async () => {
    const seen = [];
    const result = await client(async (url, { body, timeoutMs }) => {
        assert.equal(url, "https://example.invalid/v1/responses");
        assert.equal(timeoutMs, 30000);
        assert.equal(body.stream, false);
        assert.equal(body.store, false);
        assert.equal(body.tools, undefined);
        seen.push([body.model, body.reasoning.effort]);
        if (body.model === "gpt-6-luna") throw new Error("HTTP 404：当前凭证分组不支持该模型");
        return response();
    }).gpt("command");
    assert.deepEqual(seen, [["gpt-6-luna", "max"], ["gpt-6-sol", "high"]]);
    assert.equal(result.fallback, true);
    assert.equal(result.decision, "allow");
    await assert.rejects(client(async () => { throw new Error("HTTP 404：当前凭证分组不支持该模型"); }).gpt("command"), /gpt-6-luna.*404.*gpt-6-sol.*404/);
    await assert.rejects(client(async () => ({ ...response(), status: "incomplete" })).gpt("command"), /未返回完整结论/);
});

test("missing credentials fail closed before making any network call", async () => {
    const reviewers = createApprovalReviewers({ read: async () => { throw new Error("private path or secret"); }, request: async () => assert.fail("network must not run") });
    await assert.rejects(reviewers.grok("command"), (error) => /配置无法读取/.test(error.message) && !/private|secret/.test(error.message));
});

test("GPT has its own credential and never uses the Qwen-only provider key", async () => {
    let calls = 0;
    const result = await client(async (_url, { apiKey, body }) => {
        calls++;
        assert.equal(apiKey, "gpt-only-test");
        assert.notEqual(apiKey, config.models.providers.novacode.apiKey);
        assert.equal(body.model, "gpt-6-luna");
        return response();
    }).gpt("command");
    assert.equal(calls, 1);
    assert.equal(result.fallback, false);
});

async function withServer(handler, run) {
    const server = http.createServer(handler);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try { await run(`http://127.0.0.1:${server.address().port}/v1/chat/completions`); }
    finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}

test("transport sends credentials only in authorization and never follows redirects", async () => {
    await withServer((req, res) => {
        assert.equal(req.headers.authorization, "Bearer secret-for-tests");
        let body = "";
        req.on("data", (chunk) => body += chunk);
        req.on("end", () => {
            assert.deepEqual(JSON.parse(body), { model: "grok-4.7" });
            res.writeHead(302, { Location: "http://example.invalid/steal-key" });
            res.end('{}');
        });
    }, async (url) => {
        await assert.rejects(requestApprovalJson(url, { apiKey: "secret-for-tests", body: { model: "grok-4.7" }, timeoutMs: 2000 }), /HTTP 302/);
    });
});

test("upstream errors cannot leak keys, prompts or arbitrary response text", async () => {
    for (const [status, expected] of [[404, /404.*不支持/], [401, /401.*认证/], [403, /403.*客户端/], [429, /429.*额度/], [502, /502/]]) {
        await withServer((_req, res) => {
            res.writeHead(status, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: "Codex-only secret-for-tests private command evidence" } }));
        }, async (url) => {
            await assert.rejects(requestApprovalJson(url, { apiKey: "secret-for-tests", body: {}, timeoutMs: 2000 }), (error) => {
                assert.match(error.message, expected);
                assert.doesNotMatch(error.message, /secret-for-tests|private command/);
                assert.equal(error.retryable, status === 502);
                return true;
            });
        });
    }
});

test("transport timeout includes a stalled response body", async () => {
    await withServer((_req, res) => { res.writeHead(200); res.write('{"choices":'); }, async (url) => {
        await assert.rejects(requestApprovalJson(url, { apiKey: "secret-for-tests", body: {}, timeoutMs: 100 }), (error) => /超时/.test(error.message) && error.retryable);
    });
});

test("oversized and malformed responses fail closed", async () => {
    for (const payload of ["x".repeat(2 * 1024 * 1024 + 1), "not json"]) {
        await withServer((_req, res) => res.end(payload), async (url) => {
            await assert.rejects(requestApprovalJson(url, { apiKey: "secret-for-tests", body: {}, timeoutMs: 2000 }), /大小限制|非 JSON/);
        });
    }
});

test('external cancellation closes a stalled approval HTTP request without retrying', async () => {
    await withServer((_req, res) => { res.writeHead(200); res.write('{"choices":'); }, async url => {
        const controller = new AbortController();
        const pending = requestApprovalJson(url, {apiKey:'secret-for-tests',body:{},timeoutMs:2000,signal:controller.signal});
        controller.abort(new Error('review-cancelled'));
        await assert.rejects(pending,/review-cancelled/);
    });
    let calls=0;
    const controller = new AbortController();
    const reviewers = client(async () => {calls++;controller.abort(new Error('review-expired'));throw Object.assign(new Error('network'),{retryable:true});});
    await assert.rejects(reviewers.grok('evidence',{signal:controller.signal}),/review-expired/);
    assert.equal(calls,1);
    await assert.rejects(reviewers.gpt('evidence',{signal:controller.signal}),/review-expired/);
    assert.equal(calls,1);
});

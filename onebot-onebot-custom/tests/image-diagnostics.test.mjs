import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createImageDiagnostics, imageErrorDetails, redactImageDiagnostic } from "../src/src/image-diagnostics.js";

async function fixture(run) {
    const directory = await mkdtemp(join(tmpdir(), "onebot-image-diagnostics-test-"));
    const logs = [];
    const logger = { info: (s) => logs.push(s), error: (s) => logs.push(s), warn: (s) => logs.push(s) };
    try { await run({ directory, logs, logger }); }
    finally { await rm(directory, { recursive: true, force: true }); }
}

test("failed image script preserves typed errors and status lines without command, prompts or keys", async () => {
    await fixture(async ({ directory, logs, logger }) => {
        const trace = createImageDiagnostics({ directory, logger, accountId: "test", workflow: "uploaded-image-edit" });
        const failure = Object.assign(new Error("Command failed: script image-edit /source.png PRIVATE USER PROMPT\nsecret command"), {
            code: 1, signal: null, killed: false,
            stdout: 'raw_prompt=PRIVATE USER PROMPT\noptimized_prompt=PRIVATE OPTIMIZED PROMPT\nimage_edit_http=401\nimage_edit_error={"message":"invalid api_key=sk-synthetic-test-key"}\n',
            stderr: 'image_edit_attempt_http=401 curl_exit=0\nprompt_optimizer_used=direct/test-model\n',
        });
        await assert.rejects(trace.runScript(async () => { throw failure; }, "script", [], { timeout: 3600000 }), (e) => e === failure);
        await trace.fail(failure);
        const raw = await readFile(trace.path, "utf8");
        const records = raw.trim().split("\n").map(JSON.parse);
        assert.equal(records.at(-1).error.code, 1);
        assert.equal(records.at(-1).stage, "generate");
        assert.match(raw, /image_edit_http=401/);
        assert.match(raw, /prompt_optimizer_used/);
        assert.doesNotMatch(raw + logs.join(""), /PRIVATE|sk-synthetic|secret command/);
        assert.equal((await stat(directory)).mode & 0o777, 0o700);
        assert.equal((await stat(trace.path)).mode & 0o777, 0o600);
    });
});

test("successful retry diagnostics survive and trace id reaches the script", async () => {
    await fixture(async ({ directory, logger }) => {
        const trace = createImageDiagnostics({ directory, logger, workflow: "group-image-generate" });
        let calls = 0;
        const result = await trace.runScript(async (file, args, options) => {
            calls++;
            assert.equal(options.env.AGY_IMAGE_TRACE_ID, trace.id);
            assert.equal(options.env.CUSTOM_IMAGE_TEST, "preserved");
            return { stdout: 'optimized_prompt=PRIVATE\nimage_output=/tmp/result.png\n', stderr: 'image_generate_attempt_http=503 curl_exit=0\nimage_generate_attempt_http=200 curl_exit=0\n' };
        }, "script", [], { timeout: 3600000, env: { CUSTOM_IMAGE_TEST: "preserved" } });
        await trace.stage("send-image");
        await trace.stage("send-confirmation", { imageMessageId: 123 });
        await trace.complete();
        assert.equal(calls, 1);
        assert.match(result.stdout, /PRIVATE/); // caller's result is not changed
        const raw = await readFile(trace.path, "utf8");
        assert.match(raw, /503/);
        assert.match(raw, /imageMessageId":123/);
        assert.doesNotMatch(raw, /PRIVATE/);
    });
});

test("delivery failure is distinguished from generation failure and includes timeout signal", async () => {
    await fixture(async ({ directory, logger }) => {
        const trace = createImageDiagnostics({ directory, logger, workflow: "uploaded-image-edit" });
        await trace.stage("send-image");
        await trace.fail(Object.assign(new Error("upload timeout"), { code: "ETIMEDOUT", killed: true, signal: "SIGTERM" }));
        const record = JSON.parse((await readFile(trace.path, "utf8")).trim().split("\n").at(-1));
        assert.equal(record.stage, "send-image");
        assert.equal(record.error.signal, "SIGTERM");
        assert.equal(record.error.killed, true);
        assert.equal(record.error.code, "ETIMEDOUT");
    });
});

test("sensitive URL query, credentials, bearer values and image data are redacted and bounded", () => {
    const value = redactImageDiagnostic('https://user:pass@example.test/image?token=private#secret Authorization: Bearer abc.def.ghi api_key="plain-private" data:image/png;base64,AAAA');
    assert.doesNotMatch(value, /user:pass|token=private|#secret|abc.def.ghi|plain-private|base64,AAAA/);
    assert.match(value, /https:\/\/example.test\/image/);
    assert.equal(redactImageDiagnostic("!".repeat(20000)).length, 8192);
    assert.equal(imageErrorDetails(new Error("test")).code, null);
});

test("diagnostic disk failure does not repeat execution or replace the original error", async () => {
    await fixture(async ({ directory, logger, logs }) => {
        const file = join(directory, "not-a-directory");
        await writeFile(file, "occupied");
        const trace = createImageDiagnostics({ directory: file, logger, workflow: "test" });
        let calls = 0;
        const failure = new Error("original failure");
        await assert.rejects(trace.runScript(async () => { calls++; throw failure; }, "script", [], { timeout: 10 }), (error) => error === failure);
        await trace.fail(failure);
        assert.equal(calls, 1);
        assert.match(logs.join(""), /diagnostic_write_failed/);
        assert.match(logs.join(""), /original failure/);
    });
});

test("real execFile failure captures stdout that Error.toString previously omitted", async () => {
    await fixture(async ({ directory, logger }) => {
        const trace = createImageDiagnostics({ directory, logger, workflow: "real-child-process" });
        try {
            await trace.runScript(promisify(execFile), process.execPath, ["-e",
                'console.log("image_edit_http=502\\nimage_edit_error=upstream unavailable"); console.error("prompt_optimizer_used=direct/test-model"); process.exit(7);',
                "PRIVATE-CHILD-ARGUMENT"], { timeout: 5000 });
            assert.fail("child must fail");
        }
        catch (error) { await trace.fail(error); }
        const raw = await readFile(trace.path, "utf8");
        const record = JSON.parse(raw.trim().split("\n").at(-1));
        assert.equal(record.error.code, 7);
        assert.match(record.error.stdout, /image_edit_http=502/);
        assert.match(record.error.stdout, /upstream unavailable/);
        assert.match(record.error.stderr, /prompt_optimizer_used/);
        assert.doesNotMatch(raw, /PRIVATE-CHILD-ARGUMENT/);
    });
});

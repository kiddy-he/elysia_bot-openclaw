import { strict as assert } from "node:assert";
import { test } from "node:test";
import { loadAppConfig } from "../src/src/app-config.js";
import { loadModelRouting } from "../src/src/model-routing.js";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

test("application limits load and validate", () => {
    const config = loadAppConfig();
    assert.equal(config.batchGapMs, 1500);
    assert.equal(config.imageResponseTimeoutMs, 3600000);
    assert.equal(config.extendedResponseTimeoutMs, 900000);
    assert.ok(Object.isFrozen(config));
});

test("application limits retain the original defaults when the optional file is absent", () => {
    const config = loadAppConfig(join(process.env.TMPDIR ?? "/tmp", "openclaw-onebot-config-does-not-exist.json"));
    assert.equal(config.batchGapMs, 1500);
    assert.equal(config.defaultResponseTimeoutMs, 180000);
    assert.equal(config.modelReplyTimeoutMs, 180000);
    assert.equal(config.imageResponseTimeoutMs, 3600000);
    assert.equal(config.guestReplyIntervalMs, 0);
});
test('guest chat cooldown field accepts zero and missing values for unlimited private conversation', () => {
    const root = mkdtempSync(join(tmpdir(), 'guest-unlimited-config-')), path = join(root, 'app.json');
    try {
        const config = { ...loadAppConfig(), guestReplyIntervalMs: 0 };
        writeFileSync(path, JSON.stringify(config)); assert.equal(loadAppConfig(path).guestReplyIntervalMs, 0);
        delete config.guestReplyIntervalMs; writeFileSync(path, JSON.stringify(config)); assert.equal(loadAppConfig(path).guestReplyIntervalMs, 0);
        config.guestReplyIntervalMs = -1; writeFileSync(path, JSON.stringify(config)); assert.throws(() => loadAppConfig(path), /guestReplyIntervalMs/u);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('older app configs inherit the longer deadline and reject deadlines before a progress threshold', () => {
    const root = mkdtempSync(join(tmpdir(), 'staged-app-config-')), path = join(root, 'app.json');
    try {
        const config = { ...loadAppConfig() }; delete config.extendedResponseTimeoutMs;
        writeFileSync(path, JSON.stringify(config)); assert.equal(loadAppConfig(path).extendedResponseTimeoutMs, 900000);
        config.extendedResponseTimeoutMs = 250000; writeFileSync(path, JSON.stringify(config));
        assert.throws(() => loadAppConfig(path), /must exceed/u);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("model routing preserves the active conversation and fallback chains", () => {
    const routing = loadModelRouting();
    assert.match(routing.conversation.model, /^[^/]+\/[^/]+$/);
    assert.ok(routing.textReview.model);
    assert.ok(routing.contentFallbacks.length);
    assert.ok(routing.errorFallbacks.length);
});

test('model generation deadline inherits three minutes for older configs and validates overrides', () => {
    const root=mkdtempSync(join(tmpdir(),'model-reply-deadline-')),path=join(root,'app.json');
    try {
        const config={...loadAppConfig()};delete config.modelReplyTimeoutMs;
        writeFileSync(path,JSON.stringify(config));assert.equal(loadAppConfig(path).modelReplyTimeoutMs,180000);
        config.modelReplyTimeoutMs=240000;writeFileSync(path,JSON.stringify(config));assert.equal(loadAppConfig(path).modelReplyTimeoutMs,240000);
        config.modelReplyTimeoutMs=0;writeFileSync(path,JSON.stringify(config));assert.throws(()=>loadAppConfig(path),/modelReplyTimeoutMs/u);
    }finally{rmSync(root,{recursive:true,force:true});}
});

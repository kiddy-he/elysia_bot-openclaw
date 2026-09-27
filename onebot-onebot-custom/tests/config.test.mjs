import { strict as assert } from "node:assert";
import { test } from "node:test";
import { loadAppConfig } from "../src/src/app-config.js";
import { loadModelRouting } from "../src/src/model-routing.js";

test("application limits load and validate", () => {
    const config = loadAppConfig();
    assert.equal(config.batchGapMs, 1500);
    assert.equal(config.imageResponseTimeoutMs, 600000);
    assert.ok(Object.isFrozen(config));
});

test("model routing preserves the active conversation and fallback chains", () => {
    const routing = loadModelRouting();
    assert.match(routing.conversation.model, /^[^/]+\/[^/]+$/);
    assert.ok(routing.textReview.model);
    assert.ok(routing.contentFallbacks.length);
    assert.ok(routing.errorFallbacks.length);
});

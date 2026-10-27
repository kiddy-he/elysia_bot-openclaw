import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { authorizeFeature, configuredAllowFrom, featureIdentity, loadFeatureConfig, outboundTargetAllowed, validateFeatureConfig } from "../src/src/feature-policy.js";
import { bindFeatureTurn, decideFeatureTool, registerFeatureToolGuard, registerFeatureOutboundGuard } from "../src/src/feature-tools.js";

const actual = loadFeatureConfig();
const copy = () => structuredClone(actual);
const owner = { senderId: "700000003", scope: "group", groupId: "700000008", accountId: "default", explicit: true, roleCount: 1 };
const member = { ...owner, senderId: "999999" };
const visitor = { ...member, scope: "private", groupId: undefined };
const allows = (config, feature, action, context) => authorizeFeature(config, feature, action, context).allowed;

test("explicit administrator identity is independent of account admission and QQ group role", () => {
    assert.equal(featureIdentity(actual, owner), "admin");
    assert.equal(featureIdentity(actual, { ...member, role: "owner", isAdmin: true }), "member");
    assert.equal(featureIdentity(actual, visitor), "visitor");
    assert.equal(featureIdentity(actual, { ...owner, internal: true }), "internal");
});

test("existing member capabilities retain conversation, media, image and quota but no backend access", () => {
    for (const [feature, action] of [["conversation", "chat"], ["conversation", "media"], ["conversation", "quote"], ["images", "generate"], ["images", "edit"], ["quota", "query"], ["quota", "refresh"]])
        assert.equal(allows(actual, feature, action, member), true, `${feature}.${action}`);
    for (const [feature, action] of [["system", "tools"], ["qzone", "publish"], ["adsb", "read"], ["conversation", "reset"], ["conversation", "mode"]])
        assert.equal(allows(actual, feature, action, member), false, `${feature}.${action}`);
});

test("private guest keeps chat, media, generation and own reset without quota or backend", () => {
    for (const [feature, action] of [["conversation", "chat"], ["conversation", "media"], ["images", "generate"], ["conversation", "reset"]])
        assert.equal(allows(actual, feature, action, visitor), true);
    for (const [feature, action] of [["quota", "query"], ["quota", "refresh"], ["system", "tools"], ["conversation", "quote"]])
        assert.equal(allows(actual, feature, action, visitor), false);
});

test("group quota and backend require exactly one explicitly selected role", () => {
    for (const context of [{ ...owner, explicit: false }, { ...owner, roleCount: 2 }]) {
        assert.equal(allows(actual, "system", "tools", context), false);
        assert.equal(allows(actual, "quota", "refresh", context), false);
    }
    assert.equal(allows(actual, "system", "tools", owner), true);
});

test("module, action, account and group restrictions all take effect", () => {
    const config = copy();
    config.features.images.groupIds = ["700000011"];
    assert.equal(allows(config, "images", "generate", owner), false);
    assert.equal(allows(config, "images", "generate", { ...owner, groupId: "700000011" }), true);
    config.features.images.actions.generate.enabled = false;
    assert.equal(allows(config, "images", "generate", { ...owner, groupId: "700000011" }), false);
    assert.equal(allows(actual, "images", "generate", { ...owner, groupId: "123" }), false);
    assert.equal(allows(actual, "images", "generate", { ...owner, accountId: "yuexia" }), false);
});

test("Bilibili implementation remains unavailable until explicitly enabled", () => {
    const config = copy();config.features.bilibili.enabled = false;
    assert.equal(allows(config, "bilibili", "subscribe", owner), false);
    config.features.bilibili.enabled = true;
    assert.doesNotThrow(() => validateFeatureConfig(config));
    assert.equal(allows(config, "bilibili", "subscribe", owner), true);
});

test("invalid and misspelled permissions are rejected", () => {
    for (const change of [c => c.features.quota.groupIds.push("unknown"), c => c.features.images.actions.generate.profile = "administrator", c => c.profiles.owner.identities.push("groupAdmin"), c => c.features.images.enabeld = true, c => delete c.features.qzone, c => c.identities.adminIds.push("*"), c => c.accounts.default.privateAdminIds.push("999")]) {
        const config = copy();change(config);
        assert.throws(() => validateFeatureConfig(config));
    }
});

test("invalid hot reload fails closed rather than retaining earlier broad grants", () => {
    const dir = mkdtempSync(join(tmpdir(), "feature-config-test-"));
    const path = join(dir, "config.json");
    try {
        writeFileSync(path, JSON.stringify(copy()));
        assert.equal(loadFeatureConfig(path).version, 1);
        writeFileSync(path, "{invalid");
        assert.throws(() => loadFeatureConfig(path));
        const config = copy();config.features.quota.enabled = false;
        writeFileSync(path, JSON.stringify(config));
        assert.equal(loadFeatureConfig(path).features.quota.enabled, false);
    }
    finally { rmSync(dir, { recursive: true, force: true }); }
});

test("channel admission derives from the same account and group configuration", () => {
    const config = copy();
    config.accounts.default.groupIds = ["700000011", "700000008"];
    config.accounts.yuexia.groupIds = ["700000011"];
    assert.deepEqual(configuredAllowFrom("default", config), ["private:700000003", "group:700000011", "group:700000008"]);
    assert.deepEqual(configuredAllowFrom("yuexia", config), ["private:700000003", "group:700000011"]);
    config.groups["700000008"].enabled = false;
    assert.deepEqual(configuredAllowFrom("default", config), ["private:700000003", "group:700000011"]);
    assert.deepEqual(configuredAllowFrom("unknown", config), []);
});

test("outbound media and scheduled replies cannot target unlisted or disabled groups", () => {
    assert.equal(outboundTargetAllowed(actual, "default", "group", "700000008"), true);
    assert.equal(outboundTargetAllowed(actual, "yuexia", "group", "700000008"), false);
    assert.equal(outboundTargetAllowed(actual, "default", "group", "999"), false);
    const config = copy();config.groups["700000008"].enabled = false;
    assert.equal(outboundTargetAllowed(config, "default", "group", "700000008"), false);
    config.accounts.default.allowPrivateGuests = false;
    assert.equal(outboundTargetAllowed(config, "default", "private", "999"), false);
    assert.equal(outboundTargetAllowed(config, "default", "private", owner.senderId), true);
});

test("backend tool guard denies guest reads, exec composition and forged params", () => {
    for (const tool of ["exec", "read", "write", "process", "automations", "message", "web_fetch", "web_search"]) {
        const decision = decideFeatureTool(actual, tool, { command: "echo safe; python3 injected.py", senderId: owner.senderId, isAdmin: true }, member);
        assert.equal(decision.allowed, false, tool);
    }
    assert.equal(decideFeatureTool(actual, "exec", { command: "pwd" }, owner).allowed, true);
});

test("disabling one backend module prevents shell or file bypass through other modules", () => {
    const config = copy();config.features.qzone.enabled = false;
    for (const [tool, params] of [["exec", { command: "curl http://local-api" }], ["exec", { command: "/root/.openclaw/workspace/skills/e200-adsb/scripts/adsb_query.sh stats; node qzone.js" }], ["read", { path: "/root/private" }]])
        assert.equal(decideFeatureTool(config, tool, params, owner).allowed, false);
    assert.equal(decideFeatureTool(config, "web_fetch", {}, owner).allowed, false);
    assert.equal(decideFeatureTool(config, "automations", { action: "create" }, owner).allowed, false);
    assert.equal(decideFeatureTool(config, "web_search", {}, owner).allowed, true);
});

test("vision fallback retains read access only to its verified inbound image paths", () => {
    const context = { ...owner, scope: "private", allowedReadPaths: ["/tmp/openclaw-image/reference.png"] };
    assert.equal(decideFeatureTool(actual, "read", { path: "/tmp/openclaw-image/reference.png" }, context).allowed, true);
    assert.equal(decideFeatureTool(actual, "read", { path: "/root/.openclaw/secrets/key" }, context).allowed, false);
    assert.equal(decideFeatureTool(actual, "exec", { command: "cat /tmp/openclaw-image/reference.png" }, context).allowed, false);
});

test("actual hook blocks missing, ambiguous and mismatched OneBot sender contexts", () => {
    let hook;
    registerFeatureToolGuard({ on: (name, fn) => { assert.equal(name, "before_tool_call");hook = fn; } });
    const ctx = { sessionKey: "agent:main:onebot:group:group:test-feature" };
    assert.equal(hook({ toolName: "exec", params: {} }, ctx).block, true);
    const release = bindFeatureTurn(ctx.sessionKey, owner);
    try {
        assert.equal(hook({ toolName: "exec", params: { command: "pwd" } }, ctx), undefined);
        assert.equal(hook({ toolName: "exec", params: {} }, { ...ctx, requester: { senderId: member.senderId } }).block, true);
        const releaseOther = bindFeatureTurn(ctx.sessionKey, member);
        assert.equal(hook({ toolName: "exec", params: {} }, ctx).block, true);
        releaseOther();
    }
    finally { release(); }
    assert.equal(hook({ toolName: "exec", params: {} }, ctx).block, true);
    assert.equal(hook({ toolName: "exec", params: {} }, { sessionKey: "agent:main:cron:trusted" }).block, true);
});

test("scheduled output retains its declared target group", () => {
    let hook;
    registerFeatureOutboundGuard({ on: (name, fn) => { assert.equal(name, "message_sending");hook = fn; } });
    const ctx = { channelId: "onebot", sessionKey: "agent:qq-auto-elysia-normal-helper:cron:105a84d4-0037-57f4-bf30-c547efb49756:run:test" };
    assert.equal(hook({ to: "group:700000011" }, ctx), undefined);
    assert.equal(hook({ to: "group:700000008" }, ctx).cancel, true);
    assert.equal(hook({ to: "private:700000003" }, ctx).cancel, true);
    const disabled = { ...ctx, sessionKey: "agent:main:cron:723d05c2-aa4b-5ec7-adf7-4e912354e34b:run:test" };
    assert.equal(hook({ to: "private:700000003" }, disabled).cancel, true);
});

test('registered scheduled subjects cannot widen their grant through generic automation tools', () => {
    let hook; registerFeatureToolGuard({ on: (name, fn) => { hook = fn; } });
    assert.equal(hook({ toolName: 'automations', params: { action: 'create' } }, { sessionKey: 'agent:main:cron:8b67c264-f0a1-562b-a74f-6468993e246e:run:test' }).block, true);
    const id = '9b8c8f4c-8f29-53ac-8db8-681b074815ec';
    assert.equal(hook({ toolName: 'rewards_summary', params: {} }, { sessionKey: `agent:qq-auto-elysia-normal-main:cron:${id}:run:test` }), undefined);
    assert.equal(hook({ toolName: 'rewards_summary', params: {} }, { sessionKey: `agent:main:cron:${id}:run:test` }).block, true);
});

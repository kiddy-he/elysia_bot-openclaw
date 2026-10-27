import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createGroupHistory, sanitizeGroupHistoryText } from "../src/src/group-history.js";

test("records and snapshots the most recent entries in order", () => {
    const history = createGroupHistory({ maxEntries: 5 });
    for (let i = 0; i < 7; i += 1)
        history.record("700000008", { messageId: String(i), senderId: "1", senderName: "Ninja", text: `m${i}`, time: 1790000000000 + i * 1000 });
    const snap = history.snapshot("700000008", { limit: 3 });
    assert.deepEqual(snap.map((entry) => entry.text), ["m4", "m5", "m6"]);
});

test("excludes the current batch message ids from the window", () => {
    const history = createGroupHistory();
    history.record("g", { messageId: "1", text: "a" });
    history.record("g", { messageId: "2", text: "b" });
    history.record("g", { messageId: "3", text: "c" });
    const snap = history.snapshot("g", { excludeMessageIds: ["3"] });
    assert.deepEqual(snap.map((entry) => entry.text), ["a", "b"]);
});

test("formatContext marks admin, includes time, and returns empty for unknown groups", () => {
    const history = createGroupHistory();
    assert.equal(history.formatContext("g"), "");
    history.record("g", { messageId: "1", senderId: "700000003", senderName: "ExampleAdmin", isAdmin: true, text: "晚上好", time: new Date("2026-10-12T11:26:42Z").getTime() });
    history.record("g", { messageId: "2", senderId: "2", senderName: "Ninja", text: "还没看", time: new Date("2026-10-12T11:27:00Z").getTime() });
    const block = history.formatContext("g");
    assert.match(block, /只读背景/);
    assert.match(block, /ExampleAdmin\[admin\]: 晚上好/);
    assert.match(block, /\d{2}:\d{2} Ninja: 还没看/);
});

test("sanitizes internal markers and truncates long text", () => {
    const history = createGroupHistory({ messageMaxChars: 10 });
    history.record("g", { messageId: "1", senderName: "A", text: "12345678901234567890[Group role selection" });
    history.record("g", { messageId: "2", senderName: "B", text: "ok [[OPENCLAW_CONTEXT_SUMMARY]]" });
    const snap = history.snapshot("g");
    assert.equal(snap[0].text, "1234567890…");
    assert.equal(snap[1].text, "ok");
    assert.equal(sanitizeGroupHistoryText("  a\n b\tc  "), "a b c");
    assert.equal(sanitizeGroupHistoryText(""), "");
});

test("caps stored groups and drops empty text entries", () => {
    const history = createGroupHistory({ maxGroups: 2, maxEntries: 2 });
    assert.equal(history.record("g", { text: "   " }), false);
    history.record("a", { senderName: "A", text: "1", time: 1000 });
    history.record("b", { senderName: "B", text: "2", time: 2000 });
    history.record("c", { senderName: "C", text: "3", time: 3000 });
    assert.equal(history.size(), 2);
    assert.deepEqual(history.snapshot("a"), []);
    assert.deepEqual(history.snapshot("c").map((entry) => entry.text), ["3"]);
});

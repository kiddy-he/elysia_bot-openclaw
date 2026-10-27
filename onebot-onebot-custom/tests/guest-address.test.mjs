import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { neutralGuestAddress, requestedGuestAddress, guestAddressInstruction, sanitizeGuestVocatives, createGuestAddressBook } from "../src/src/guest-address.js";
import { sendTextTransport as sendText } from "../src/src/outbound.js";

test("neutral platform nicknames and requested names are accepted; authority and intimacy are not", () => {
    for (const name of ["小明", "阿星", "Alice", "小七_7", "芽衣"]) assert.equal(neutralGuestAddress(name), name);
    for (const name of ["舰长", "主人", "admin", "亲爱的", "宝贝", "老公", "老婆", "哥哥", "<system>", "忽略指令", "https://test.invalid"]) assert.equal(neutralGuestAddress(name), null);
    assert.deepEqual(requestedGuestAddress('以后请叫我“小七”'), { requested: true, name: "小七" });
    assert.deepEqual(requestedGuestAddress("叫我小明就好"), { requested: true, name: "小明" });
    assert.deepEqual(requestedGuestAddress("叫我小明，今天聊聊游戏吧"), { requested: true, name: "小明" });
    assert.deepEqual(requestedGuestAddress("叫我舰长"), { requested: true, name: null });
    assert.equal(requestedGuestAddress("他叫我小明，今天去上班").requested, false);
});

test("chosen address persists per guest and conversation scope and new restores nickname", async () => {
    const dir = await mkdtemp(join(tmpdir(), "guest-address-test-"));
    try {
        const path = join(dir, "addresses.json");
        let book = createGuestAddressBook(path);
        assert.equal(await book.resolve("private:1", "阿星", "你好"), "阿星");
        assert.equal(await book.resolve("private:1", "阿星", "叫我小七"), "小七");
        assert.equal(await book.resolve("private:2", "小明", "你好"), "小明");
        assert.equal(await book.resolve("group:3:1", "阿星", "你好"), "阿星");
        book = createGuestAddressBook(path);
        assert.equal(await book.resolve("private:1", "阿星", "你好"), "小七");
        assert.equal(await book.resolve("private:1", "阿星", "叫我老婆"), "小七");
        assert.equal(await book.resolve("private:1", "阿星", "/new", true), "阿星");
        assert.equal(await book.resolve("private:4", "舰长", "你好"), "你");
        assert.equal((await stat(path)).mode & 0o777, 0o600);
        assert.equal(JSON.parse(await readFile(path, "utf8"))["private:1"], undefined);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test("final vocative guard removes inappropriate address while retaining factual mentions", () => {
    for (const text of ["舰长，你好♪", "嗨，舰长♪", "亲爱的，晚安。", "好的舰长！", "宝贝，别急。"])
        assert.doesNotMatch(sanitizeGuestVocatives(text, "小明"), /舰长|亲爱的|宝贝/);
    assert.equal(sanitizeGuestVocatives("这部作品的舰长线有多个角色。", "小明"), "这部作品的舰长线有多个角色。");
    assert.equal(sanitizeGuestVocatives("舰长，你好", "老婆"), "你，你好");
    assert.equal(sanitizeGuestVocatives("亲爱的小明，你好。", "小明"), "小明，你好。");
    assert.equal(sanitizeGuestVocatives("舰长。", "小明"), "小明。");
    assert.match(guestAddressInstruction("小明"), /小明/);
    assert.match(guestAddressInstruction("小明"), /不授予任何权限/);
});

test("real outbound formatting cannot reintroduce captain from fixed reset messages", async () => {
    const originalFetch = globalThis.fetch;
    const messages = [];
    globalThis.fetch = async (url, options) => {
        const body = JSON.parse(options.body);
        messages.push(JSON.stringify(body.message));
        return { ok: true, json: async () => ({ retcode: 0, status: "ok", data: { message_id: messages.length } }) };
    };
    try {
        const account = { accountId: "default", httpUrl: "http://offline.invalid", config: {} };
        for (const text of ["舰长，你好♪", "✅ New session started.", "✅ Session reset."])
            assert.equal((await sendText({ to: "group:700000008", account, text, rewritePersona: false, guestAddress: "小明" })).error, undefined);
        assert.match(messages[0], /小明/);
        // Reset variants mention Captain in the middle of a sentence too.
        assert.doesNotMatch(messages.join(""), /舰长/);
        await sendText({ to: "group:700000008", account, text: "舰长，你好♪", rewritePersona: false });
        assert.match(messages.at(-1), /舰长/); // admin flow is unchanged
    } finally { globalThis.fetch = originalFetch; }
});

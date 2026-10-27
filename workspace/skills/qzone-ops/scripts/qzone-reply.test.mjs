import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { replyQzoneMsg, commentQzoneMsg } from "./qzone-client.mjs";

const params = { hostUin: "700000006", tid: "synthetic-post123", commentId: "2", replyUin: "1807533371", content: "收到这份心意啦♪" };
function fixture(t, { fail, wrongRoot = false, preexisting = false, recipient = params.replyUin } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "qzone-native-reply-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const writes = []; let delivered = preexisting;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).includes("get_cookies")) return Response.json({ status: "ok", data: { cookies: "uin=o700000006; skey=old; p_skey=ticket" } });
    if (String(url).includes("msglist_v6")) return Response.json({ code: 0, msglist: [{ tid: params.tid, commentlist: [
      { tid: 2, uin: Number(recipient), content: "原评论", list_3: delivered && !wrongRoot ? [{ tid: 1, uin: 700000006, content: `@{uin:${params.replyUin},nick:测试,auto:1}${params.content}` }] : [] },
      ...(wrongRoot && delivered ? [{ tid: 3, uin: 700000006, content: params.content }] : []),
    ] }] });
    assert.match(String(url), /emotion_cgi_re_feeds/u);
    writes.push(new URLSearchParams(options.body));
    if (fail) throw new Error("connection lost after POST");
    delivered = true;
    return Response.json({ code: 0, subcode: 0, data: { feeds: "" } });
  });
  return { stateDir, writes };
}

test("native reply binds the parent and recipient, sends plain text, verifies nested delivery and deduplicates changed wording/account aliases", async t => {
  const f = fixture(t);
  const first = await replyQzoneMsg(params, f);
  assert.equal(first.nativeReply, true); assert.equal(first.alreadyReplied, false);
  const body = f.writes[0];
  for (const [key, value] of Object.entries({ paramstr: "2", hostUin: params.hostUin, topicId: `${params.hostUin}_${params.tid}__1`,
    commentId: "2", commentUin: params.replyUin, t1_uin: params.hostUin, t1_tid: params.tid, t2_uin: params.replyUin, t2_tid: "2", content: params.content })) assert.equal(body.get(key), value);
  assert.doesNotMatch(body.get("content"), /@/u);
  const again = await replyQzoneMsg({ ...params, account: "700000006", content: "换一种措辞重试" }, f);
  assert.equal(again.alreadyReplied, true); assert.equal(f.writes.length, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(f.stateDir, fs.readdirSync(f.stateDir)[0]), "utf8"));
  assert.equal(saved.state, "succeeded"); assert.doesNotMatch(JSON.stringify(saved), /p_skey|ticket|收到这份心意/u);
});

test("concurrent attempts on the same comment claim only one POST", async t => {
  const f = fixture(t);
  const results = await Promise.allSettled([replyQzoneMsg(params, f), replyQzoneMsg({ ...params, content: "另一种措辞" }, f)]);
  assert.equal(f.writes.length, 1); assert.ok(results.some(item => item.status === "fulfilled"));
});

test("a lost POST response persists uncertainty and blocks new calls after state reload", async t => {
  const f = fixture(t, { fail: true });
  await assert.rejects(replyQzoneMsg(params, f), /阻止自动重发/u);
  await assert.rejects(replyQzoneMsg({ ...params, content: "换措辞重试" }, { stateDir: f.stateDir }), /uncertain/u);
  assert.equal(f.writes.length, 1);
});

test("server code zero at the root is not native reply success and cannot trigger a fallback or second POST", async t => {
  const f = fixture(t, { wrongRoot: true });
  await assert.rejects(replyQzoneMsg(params, f), /回读未确认原评论下/u);
  await assert.rejects(replyQzoneMsg(params, f), /uncertain/u);
  assert.equal(f.writes.length, 1);
});

test("missing parent, mismatched recipient and existing native reply never write", async t => {
  const f = fixture(t, { recipient: "2083265281" });
  await assert.rejects(replyQzoneMsg(params, f), /未在最新 commentlist/u); assert.equal(f.writes.length, 0);
});

test("an existing native reply prevents duplicates even when the local ledger is absent", async t => {
  const f = fixture(t, { preexisting: true });
  await assert.rejects(replyQzoneMsg(params, f), /已有本账号的原生回复/u); assert.equal(f.writes.length, 0);
});

test("mentions and incomplete or injected reply targets fail before accessing the network", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("must not access network"); });
  for (const content of ["@{uin:1807533371,nick:测试}回复", "@测试 回复", "[CQ:at,qq=1807533371]回复"]) {
    await assert.rejects(replyQzoneMsg({ ...params, content }), /不要用艾特/u);
    await assert.rejects(commentQzoneMsg({ ...params, commentId: undefined, replyUin: undefined, content }), /不要用艾特/u);
  }
  for (const change of [{ commentId: undefined }, { replyUin: undefined }, { commentId: "2;id" }, { hostUin: "bad" }, { tid: "../x" }])
    await assert.rejects(replyQzoneMsg({ ...params, ...change }), /required|Invalid/u);
});

test("explicit new root comments retain paramstr=1 and have no native reply fields", async t => {
  let body;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).includes("get_cookies")) return Response.json({ status: "ok", data: { cookies: "uin=o700000006; skey=old; p_skey=ticket" } });
    body = new URLSearchParams(options.body); return Response.json({ code: 0, subcode: 0 });
  });
  await commentQzoneMsg({ hostUin: params.hostUin, tid: params.tid, content: "新的一级评论" });
  assert.equal(body.get("paramstr"), "1"); assert.equal(body.has("t2_tid"), false);
});

test("real CLI subprocess sends once and a new process reuses the durable receipt even after rewording", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qzone-reply-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const preload = path.join(dir, "mock-network.mjs"), journal = path.join(dir, "writes.json");
  fs.writeFileSync(preload, `import fs from 'node:fs';
    const journal = ${JSON.stringify(journal)};
    globalThis.fetch = async (url, options) => {
      if (String(url).includes('get_cookies')) return Response.json({status:'ok',data:{cookies:'uin=o700000006; p_skey=test-only'}});
      if (String(url).includes('emotion_cgi_re_feeds')) {
        const body = new URLSearchParams(options.body);
        const writes = fs.existsSync(journal) ? JSON.parse(fs.readFileSync(journal)) : [];
        writes.push({ paramstr: body.get('paramstr'), commentId: body.get('commentId'), content: body.get('content') });
        fs.writeFileSync(journal, JSON.stringify(writes));
        return Response.json({code:0,subcode:0});
      }
      if (String(url).includes('msglist_v6')) {
        const writes = fs.existsSync(journal) ? JSON.parse(fs.readFileSync(journal)) : [];
        return Response.json({code:0,msglist:[{tid:'synthetic-post123',commentlist:[{tid:2,uin:1807533371,list_3:writes.map((w,i)=>({tid:i+1,uin:700000006,content:w.content}))}]}]});
      }
      throw new Error('network disabled in test');
    };`);
  const cli = fileURLToPath(new URL('./qzone-cli.mjs', import.meta.url));
  const run = (content, command = 'reply') => execFileSync(process.execPath, ['--import', preload, cli, command, '--host', params.hostUin, '--tid', params.tid,
    '--comment-id', params.commentId, '--reply-uin', params.replyUin, '--content', content], { encoding: 'utf8', env: { ...process.env, QZONE_REPLY_STATE_DIR: path.join(dir, 'state') }, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(JSON.parse(run(params.content)).nativeReply, true);
  assert.equal(JSON.parse(run('换个措辞再次调用')).alreadyReplied, true);
  const writes = JSON.parse(fs.readFileSync(journal, 'utf8'));
  assert.deepEqual(writes, [{ paramstr: '2', commentId: '2', content: params.content }]);
  assert.throws(() => run(params.content, 'comment'), error => /必须使用 reply/u.test(String(error.stderr)));
  assert.equal(JSON.parse(fs.readFileSync(journal, 'utf8')).length, 1);
});

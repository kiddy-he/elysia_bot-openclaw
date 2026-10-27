import test from "node:test";
import assert from "node:assert/strict";
import { parseQzoneResponse, readQzoneResponse } from "./qzone-response.mjs";
import { getQzoneCredentials, getQzoneMsgList } from "./qzone-client.mjs";

test("reads JSON and the legacy feeds object without losing HTML or Unicode", () => {
  assert.deepEqual(parseQzoneResponse('{"code":0,"msglist":null}'), { code: 0, msglist: null });
  const result = parseQzoneResponse(String.raw`{code:0, subcode:0, data:{main:{hasMoreFeeds:true,html:'<div>中文\x2f</div>'},items:[{uin:undefined,value:-3},,null],},}`);
  assert.equal(result.data.main.html, "<div>中文/</div>");
  assert.deepEqual(result.data.items, [{ uin: null, value: -3 }, null, null]);
});

test("accepts JSONP data without invoking its callback", () => {
  assert.deepEqual(parseQzoneResponse('\uFEFF _Callback({code:0, data:{x:undefined}});'), { code: 0, data: { x: null } });
});

test("rejects executable expressions and never runs returned JavaScript", () => {
  globalThis.qzoneExecuted = false;
  for (const source of [
    '{code:0,data:(globalThis.qzoneExecuted=true)}',
    '{code:0,data:(()=>{globalThis.qzoneExecuted=true})()}',
    '{code:0,get data(){globalThis.qzoneExecuted=true}}',
    '{code:0,[globalThis.qzoneExecuted=true]:1}',
    '{code:0,...{data:1}}',
    '{code:0,data:process.env}',
    '{code:0,data:/test/}',
    '{code:0});globalThis.qzoneExecuted=true;({code:0}',
  ]) assert.throws(() => parseQzoneResponse(source), /unsupported or invalid/);
  assert.equal(globalThis.qzoneExecuted, false);
  delete globalThis.qzoneExecuted;
});

test("prototype-named data properties do not alter object prototypes", () => {
  const result = parseQzoneResponse('{code:0,data:{__proto__:{qzonePolluted:true}}}');
  assert.equal(Object.hasOwn(result.data, "__proto__"), true);
  assert.equal(result.data.qzonePolluted, undefined);
  assert.equal({}.qzonePolluted, undefined);
});

test("rejects HTML, missing business codes, and nonzero business codes", () => {
  for (const source of ['<html>login</html>', '{}', '[]', 'null', '{code:null}', '{code:[]}', '{code:true}']) {
    assert.throws(() => parseQzoneResponse(source));
  }
  assert.throws(() => parseQzoneResponse('{code:-3000,subcode:-1,message:"SECRET"}', "msglist"), (error) => {
    assert.match(error.message, /msglist: Qzone returned code -3000/);
    assert.doesNotMatch(error.message, /SECRET/);
    return true;
  });
});

test("HTTP failures cannot be mistaken for Qzone success", async () => {
  await assert.rejects(readQzoneResponse(new Response('{"code":0}', { status: 403 }), "feeds"), /HTTP 403/);
  assert.deepEqual(await readQzoneResponse(new Response('{code:0,data:undefined}'), "feeds"), { code: 0, data: null });
});

test("rejects unknown accounts and invalid read arguments before making requests", async () => {
  await assert.rejects(getQzoneCredentials("typo"), /Unknown account/);
  await assert.rejects(getQzoneMsgList({ targetUin: "not-a-qq" }), /Invalid target/);
  await assert.rejects(getQzoneMsgList({ num: NaN }), /Invalid num/);
});

test("read flow uses the requested target and p_skey token and propagates access errors", async (t) => {
  const seen = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    seen.push({ url: String(url), options });
    if (seen.length % 2 === 1) {
      return Response.json({ status: "ok", data: { cookies: "uin=o700000006; skey=old; p_skey=new", bkn: "incorrect" } });
    }
    return new Response(seen.length === 2 ? '{code:0,msglist:[{tid:"test",content:"中文"}]}' : '{code:-10000,message:"denied"}');
  });
  const result = await getQzoneMsgList({ targetUin: "700000003", num: 3 });
  assert.equal(result.msglist.length, 1);
  const url = new URL(seen[1].url);
  assert.equal(url.searchParams.get("uin"), "700000003");
  assert.equal(url.searchParams.get("num"), "3");
  assert.notEqual(url.searchParams.get("g_tk"), "incorrect");
  assert.match(seen[1].options.headers.Cookie, /p_skey=new/);
  await assert.rejects(getQzoneMsgList({ targetUin: "700000003" }), /code -10000/);
});

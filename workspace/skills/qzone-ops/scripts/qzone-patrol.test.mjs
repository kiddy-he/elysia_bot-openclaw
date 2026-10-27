import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFeedPage, commentEvents, observePatrol, executePatrol, validatePublicReply } from './qzone-patrol.mjs';
import { getQzoneFeeds, setQzoneLike, replyQzoneMsg } from './qzone-client.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const own = '700000006', other = '1807533371', start = Date.parse('2026-10-19T01:00:00+08:00');
const root = (tid, content = '这束花真漂亮！', uin = other, time = start + 10000) => ({ tid, uin, name: '来访者', content, create_time: time / 1000 });
const post = comments => ({ tid: 'synthetic-post-123', uin: own, content: '公开花店动态', commentlist: comments });
const feed = (id = 'new-feed-123', owner = other, time = start + 10000) => ({ key: id, owner, tid: id, appid: 311, typeid: 0, abstime: time / 1000,
  unikey: `http://user.qzone.qq.com/${owner}/mood/${id}`, curkey: 'same', liked: false });
function fixture() {
  const state = { version: 1, accountId: 'default', ownerUin: own };
  observePatrol(state, { feeds: [feed('old-feed', other, start - 100000)], posts: [post([root(1, '旧评论', other, start - 100000)])] }, start);
  let clock = start + 20000; const calls = [];
  const deps = { persist() {}, now: () => clock, random: () => 0, wait: async ms => { clock += ms; },
    compose: async context => { calls.push(['compose', context]); return { reply: '这份花香，也分给你一点啦♪', model: 'synthetic' }; },
    like: async item => { calls.push(['like', item.tid]); },
    reply: async event => { calls.push(['reply', event.key]); return { nativeReply: true }; },
  };
  return { state, calls, deps };
}

test('feed normalization ignores null/ads and preserves native music/share like keys and pagination', () => {
  const response = { data: { main: { hasMoreFeeds: true, externparam: 'basetime=123&pagenum=2' }, data: [null,
    { opuin: '0', appid: '6600', key: 'advertisement_outlink_0' },
    { opuin: other, appid: '202', typeid: '0', key: 'music-share', abstime: '1234567890', html: '<a class="like" data-islike="1" data-unikey="https://music.example/song?id=1&amp;x=2" data-curkey="native-key">' },
  ] } };
  const result = normalizeFeedPage(response);
  assert.equal(result.items.length, 1); assert.equal(result.items[0].appid, 202); assert.equal(result.items[0].liked, true);
  assert.equal(result.items[0].unikey, 'https://music.example/song?id=1&x=2'); assert.equal(result.cursor, 'basetime=123&pagenum=2');
  assert.throws(() => normalizeFeedPage({ data: {} }), /Invalid/u);
});

test('first snapshot only creates baseline, and older cards/comments discovered later are never backfilled', async () => {
  const state = { ownerUin: own }, writes = [];
  const deps = { persist() {}, now: () => start, like: async () => writes.push('like'), reply: async () => writes.push('reply'), compose: async () => writes.push('compose') };
  const baseline = await executePatrol(state, { feeds: [feed('existing', other, start)], posts: [post([root(1, 'existing', other, start)])] }, deps);
  assert.equal(baseline.baseline, true);
  await executePatrol(state, { feeds: [feed('existing', other, start), feed('hidden-old', other, start - 100000)], posts: [post([root(1, 'existing', other, start), root(2, 'hidden-old', other, start - 100000)])] }, deps);
  assert.deepEqual(writes, []);
});

test('new feed and root comment produce one like and one native reply; replay and reopening never duplicate', async () => {
  const f = fixture(), snapshot = { feeds: [feed()], posts: [post([root(2), root(3, 'self comment', own)])] };
  const result = await executePatrol(f.state, snapshot, f.deps);
  assert.equal(result.likes, 1); assert.equal(result.replies, 1);
  const reopened = JSON.parse(JSON.stringify(f.state)); await executePatrol(reopened, snapshot, f.deps);
  assert.equal(f.calls.filter(c => c[0] === 'like').length, 1); assert.equal(f.calls.filter(c => c[0] === 'reply').length, 1);
  const context = f.calls.find(c => c[0] === 'compose')[1];
  assert.deepEqual(Object.keys(context).sort(), ['newComment', 'post', 'thread']); assert.doesNotMatch(JSON.stringify(context), /\/root|private-chat|apiKey/u);
});

test('new own posts are liked too; already liked cards are not posted again', async () => {
  const f = fixture();
  const a = feed('own-post-new', own), b = { ...feed('already-liked'), liked: true };
  const result = await executePatrol(f.state, { feeds: [a, b], posts: [] }, f.deps);
  assert.equal(result.likes, 1); assert.deepEqual(f.calls.filter(c => c[0] === 'like'), [['like', a.tid]]);
});

test('new replies inside a thread are new events, while own replies cannot trigger a conversation loop', () => {
  const parent = { ...root(2), list_3: [root(1, '自己的回复', own), root(2, '另一位的新回复', '2083265281')] };
  const events = commentEvents([post([parent])], own);
  assert.equal(events.length, 2); assert.notEqual(events[0].key, events[1].key);
  assert.equal(events[1].kind, 'reply'); assert.equal(events[1].parentId, '2'); assert.equal(events[1].authorUin, '2083265281');
  assert.equal(events.some(e => e.authorUin === own), false);
});

test('editing an existing comment does not turn it into a new reply trigger', () => {
  const before = commentEvents([post([root(2, '原文')])], own);
  const after = commentEvents([post([root(2, '编辑后的文字')])], own);
  assert.equal(before[0].key, after[0].key);
});

test('a new comment already answered manually before this tick does not get a second automatic reply', async () => {
  const f = fixture();
  const parent = { ...root(2), list_3: [root(1, '已通过别的会话回复', own, start + 15000)] };
  const result = await executePatrol(f.state, { feeds: [], posts: [post([parent])] }, f.deps);
  assert.equal(result.replies, 0); assert.equal(Object.values(f.state.replies)[0].state, 'succeeded');
  assert.equal(f.calls.length, 0);
});

test('lost comment receipt stays uncertain until actual thread readback proves delivery; no rephrased retry', async () => {
  const f = fixture(), parent = root(2), snapshot = { feeds: [], posts: [post([parent])] };
  f.deps.reply = async event => { f.calls.push(['reply', event.key]); throw new Error('lost after POST'); };
  await executePatrol(f.state, snapshot, f.deps);
  const record = Object.values(f.state.replies)[0]; assert.equal(record.state, 'uncertain');
  await executePatrol(f.state, snapshot, f.deps); assert.equal(f.calls.filter(c => c[0] === 'reply').length, 1);
  parent.list_3 = [root(1, record.draft, own, record.startedAt + 1000)];
  await executePatrol(f.state, snapshot, f.deps);
  assert.equal(record.state, 'succeeded'); assert.equal(f.calls.filter(c => c[0] === 'reply').length, 1);
});

test('action budget defers the backlog without dropping it, and revoked feature permissions prevent writes', async () => {
  const f = fixture(), snapshot = { feeds: [feed('one-feed'), feed('two-feed')], posts: [] };
  assert.equal((await executePatrol(f.state, snapshot, { ...f.deps, maxActions: 1 })).likes, 1);
  assert.equal(Object.values(f.state.likes).filter(r => r.state === 'pending').length, 1);
  assert.equal((await executePatrol(f.state, snapshot, { ...f.deps, enabled: () => false })).likes, 0);
  assert.equal((await executePatrol(f.state, snapshot, f.deps)).likes, 1);
});

test('model failures retry next tick without a POST, and mention/internal output is rejected locally', async () => {
  const f = fixture(), snapshot = { feeds: [], posts: [post([root(2)])] };
  f.deps.compose = async () => ({ reply: '@陌生人 舰长 /root/private', model: 'synthetic' });
  await executePatrol(f.state, snapshot, f.deps);
  assert.equal(Object.values(f.state.replies)[0].state, 'pending'); assert.equal(f.calls.filter(c => c[0] === 'reply').length, 0);
  for (const output of ['@{uin:12345}内容', '舰长你好呀', 'API Key 是假的', 'https://example.org/abc', '']) assert.throws(() => validatePublicReply(output));
});

test('feed continuation and real non-311 like payload use verified metadata without toggling', async t => {
  const writes = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).includes('get_cookies')) return Response.json({ status: 'ok', data: { cookies: 'uin=o700000006; p_skey=test' } });
    writes.push({ url: String(url), body: options.body ? new URLSearchParams(options.body) : null }); return Response.json({ code: 0, subcode: 0 });
  });
  await getQzoneFeeds({ cursor: 'basetime=1234567890&pagenum=2', pageNum: 2 });
  const url = new URL(writes[0].url); assert.equal(url.searchParams.get('begintime'), '1234567890'); assert.equal(url.searchParams.get('refresh'), '0');
  await setQzoneLike({ targetUin: other, tid: 'music-share', appid: 202, unikey: 'https://music.example/song', curkey: 'native-key' });
  assert.equal(writes[1].body.get('appid'), '202'); assert.equal(writes[1].body.get('curkey'), 'native-key'); assert.match(writes[1].url, /internal_dolike_app/u);
});

test('trusted follow-up trigger permits a new native thread reply while reworded repeats of that trigger remain deduplicated', async t => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patrol-trigger-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  let posts = 0; const text = '这一份小惊喜，也想分享给你呢♪';
  const parent = { ...root(2), list_3: [root(1, '先前的原生回复', own, start)] };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).includes('get_cookies')) return Response.json({ status: 'ok', data: { cookies: 'uin=o700000006; p_skey=test' } });
    const body = new URLSearchParams(options.body); assert.equal(body.get('paramstr'), '2'); assert.equal(body.get('content'), text);
    posts++; parent.list_3.push(root(2, text, own, start + 20000)); return Response.json({ code: 0, subcode: 0 });
  });
  const params = { hostUin: own, tid: 'synthetic-post-123', commentId: '2', replyUin: other, content: text };
  const deps = { stateDir, getParent: async () => parent, trigger: 'a'.repeat(64) };
  assert.equal((await replyQzoneMsg(params, deps)).nativeReply, true);
  assert.equal((await replyQzoneMsg({ ...params, content: '换一种说法也不能再发一次' }, deps)).alreadyReplied, true); assert.equal(posts, 1);
});

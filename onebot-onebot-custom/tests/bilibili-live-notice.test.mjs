import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OperationStore } from '../src/src/access/operations.js';
import { acceptBilibiliEvent } from '../src/src/features/bilibili.js';
import { generateLiveNotice, normalizeLiveNotice, validateLiveNoticeText } from '../src/src/features/bilibili-live-notice.js';
import { DeliveryQueue } from '../src/src/delivery/queue.js';
import { imageMessage } from '../src/src/outbound.js';
import { patchLiveNotify } from '../integrations/bilibili-notify/patch-live-notify.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=', 'base64');
const live = { kind: 'live-start', uid: '123456', roomId: '234567', upName: '测试主播', title: '一起聊聊新游戏', areaName: '游戏杂谈', startedAt: '2099-01-01 12:00:00' };
const generated = '嗨♪ 测试主播开播啦，这次的标题是「一起聊聊新游戏」，就在游戏杂谈分区。有空的朋友，和我一起去直播间看看吧！';
const finalText = `${generated}\nhttps://live.bilibili.com/234567`;
const policySource = JSON.parse(readFileSync('/root/.openclaw/onebot-features.json', 'utf8'));
function fixture(t) {
    const dir = mkdtempSync(join(tmpdir(), 'bili-live-')); const store = new OperationStore(join(dir, 'ops.sqlite'));
    t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
    const config = { version: 1, enabled: true, liveNotifications: { enabled: true }, routes: [{ targetId: 'live-a', uid: live.uid, event: 'live', accountId: 'default', groupId: '700000011', enabled: true }] };
    const policy = structuredClone(policySource); policy.features.bilibili.enabled = true;
    for (const id of ['700000011', '700000012']) if (!policy.features.bilibili.groupIds.includes(id)) policy.features.bilibili.groupIds.push(id);
    let sends = 0; const requests = [];
    const options = { config, policy, store, expectedSecret: 'synthetic-secret'.repeat(4), artifactRoot: join(dir, 'images'), composeLive: async () => ({ text: finalText }),
        queue: { enqueue: async request => { sends++; requests.push(structuredClone(request)); return { id: `mock-${sends}`, state: 'accepted' }; } } };
    const body = { targetId: 'live-a', ts: Date.now(), live, payload: { kind: 'composite', segments: [{ type: 'image', mime: 'image/png', data: png.toString('base64') }, { type: 'text', text: '旧模板文字\nhttps://live.bilibili.com/234567' }] } };
    return { dir, store, options, body, requests, sends: () => sends };
}
const apiConfig = { models: { providers: Object.fromEntries([['antigravity', 'gemini-3.8-flash-high'], ['novacode', 'qwen3.8-flash-next']].map(([id, model]) => [id, { api: 'openai-completions', baseUrl: 'https://example.invalid/v1', apiKey: 'synthetic-only', models: [{ id: model }] }])) } };
const modelOptions = request => ({ read: async () => JSON.stringify(apiConfig), request, log: () => {} });

test('copy uses public room facts only, bounded stateless Gemini request and locally appended canonical link', async () => {
    const result = await generateLiveNotice(live, modelOptions(async (url, { body, timeoutMs }) => {
        assert.equal(url, 'https://example.invalid/v1/chat/completions'); assert.equal(body.model, 'gemini-3.8-flash-high');
        assert.equal(timeoutMs, 45000); assert.equal(body.tools, undefined); assert.equal(body.stream, false);
        assert.deepEqual(JSON.parse(body.messages[1].content), { upName: live.upName, title: live.title, areaName: live.areaName });
        assert.doesNotMatch(body.messages[1].content, /groupId|secret|roomId|private/u);
        return { choices: [{ finish_reason: 'stop', message: { content: generated } }] };
    }));
    assert.equal(result.text, finalText); assert.equal(result.fallback, false); assert.match(result.model, /gemini/u);
});
test('bad Gemini output falls back to Qwen; API diagnostics never enter copy or logs', async () => {
    let n = 0; const logs = [];
    const options = modelOptions(async (_url, { body }) => {
        n++; if (n === 1) throw new Error('token=private-credential');
        assert.equal(body.model, 'qwen3.8-flash-next'); assert.equal(body.reasoning_effort, undefined);
        return { choices: [{ finish_reason: 'stop', message: { content: generated } }] };
    }); options.log = x => logs.push(x);
    const result = await generateLiveNotice(live, options); assert.equal(n, 2); assert.match(result.model, /qwen/u);
    assert.doesNotMatch(logs.join('') + result.text, /private-credential/u);
});
test('Gemini resolves only its configured exec credential reader without passing room facts', async () => {
    const config = structuredClone(apiConfig);
    config.models.providers.antigravity.apiKey = { source: 'exec', provider: 'antigravity_key', id: 'ANTIGRAVITY_API_KEY' };
    config.secrets = { providers: { antigravity_key: { command: '/example/reader', args: ['fixed-argument'] } } };
    let reads = 0;
    const options = modelOptions(async (_url, { apiKey }) => {
        assert.equal(apiKey, 'synthetic-exec-value');
        return { choices: [{ finish_reason: 'stop', message: { content: generated } }] };
    });
    options.read = async () => JSON.stringify(config);
    options.readExec = async (source, id) => { reads++; assert.deepEqual(source, config.secrets.providers.antigravity_key); assert.equal(id, 'ANTIGRAVITY_API_KEY'); return 'synthetic-exec-value'; };
    assert.equal((await generateLiveNotice(live, options)).fallback, false); assert.equal(reads, 1);
});
test('both failures give a factual invitation and exact link; missing fields are not fabricated', async () => {
    let calls = 0;
    const result = await generateLiveNotice({ ...live, title: '', areaName: '' }, modelOptions(async () => { calls++; throw new Error('timeout'); }));
    assert.equal(calls, 2); assert.equal(result.fallback, true); assert.match(result.text, /测试主播.*一起/su);
    assert.match(result.text, /https:\/\/live\.bilibili\.com\/234567$/u); assert.doesNotMatch(result.text, /游戏杂谈|一起聊聊新游戏/u);
});
test('model cannot omit facts, add mentions, leak internal instructions or substitute a link', () => {
    for (const output of [generated.replace(live.title, '神秘直播'), `${generated} [CQ:at,qq=all]`, `${generated} @全体`, `${generated} 舰长`, `${generated} 提示词`, `${generated} https://evil.invalid/`])
        assert.throws(() => validateLiveNoticeText(output, live));
    assert.throws(() => normalizeLiveNotice(live, '999'), /invalid/u);
    assert.throws(() => normalizeLiveNotice({ ...live, roomId: 'http://127.0.0.1' }, live.uid), /invalid/u);
});
test('image waits for copy and is delivered as one captioned part; concurrent replay invokes model and queue once', async t => {
    const f = fixture(t); let release; let models = 0;
    const ready = new Promise(resolve => { release = resolve; });
    f.options.composeLive = async info => { models++; assert.deepEqual(info, live); await ready; return { text: finalText }; };
    const a = acceptBilibiliEvent(f.body, f.options.expectedSecret, f.options);
    const b = acceptBilibiliEvent({ ...f.body, ts: Date.now() }, f.options.expectedSecret, f.options);
    await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(models, 1); assert.equal(f.sends(), 0);
    release(); await Promise.all([a, b]); assert.equal(f.sends(), 1);
    assert.equal(f.requests[0].parts.length, 1); const part = f.requests[0].parts[0];
    assert.equal(part.type, 'image'); assert.equal(part.caption, finalText); assert.deepEqual(readFileSync(part.path), png);
    assert.deepEqual(imageMessage('file:///mock.jpg', part.caption), [{ type: 'image', data: { file: 'file:///mock.jpg' } }, { type: 'text', data: { text: finalText } }]);
    await acceptBilibiliEvent(f.body, f.options.expectedSecret, f.options); assert.equal(models, 1); assert.equal(f.sends(), 1);
});
test('same live event reaches each subscribed group independently; refreshed card does not duplicate one group', async t => {
    const f = fixture(t);
    f.options.config.routes.push({ ...f.options.config.routes[0], targetId: 'live-b', groupId: '700000012' });
    await acceptBilibiliEvent(f.body, f.options.expectedSecret, f.options);
    await acceptBilibiliEvent({ ...f.body, targetId: 'live-b' }, f.options.expectedSecret, f.options);
    await acceptBilibiliEvent({ ...f.body, payload: { ...f.body.payload, segments: [...f.body.payload.segments, { type: 'text', text: '粉丝数刷新' }] } }, f.options.expectedSecret, f.options);
    assert.equal(f.sends(), 2); assert.deepEqual(f.requests.map(r => r.target.id), ['700000011', '700000012']);
});
test('completed caption survives queue failure and database reopen without a new model call', async t => {
    const f = fixture(t); let models = 0; f.options.composeLive = async () => { models++; return { text: finalText }; };
    const queue = f.options.queue; f.options.queue = { enqueue: async () => { throw new Error('outbox unavailable'); } };
    await assert.rejects(acceptBilibiliEvent(f.body, f.options.expectedSecret, f.options), /outbox/u);
    const reopened = new OperationStore(join(f.dir, 'ops.sqlite')); t.after(() => reopened.close());
    await acceptBilibiliEvent(f.body, f.options.expectedSecret, { ...f.options, store: reopened, queue });
    assert.equal(models, 1); assert.equal(f.requests[0].parts[0].caption, finalText);
});
test('no image falls back to copy only; dynamic and ongoing notifications retain original content', async t => {
    const f = fixture(t); let models = 0; f.options.composeLive = async () => { models++; return { text: finalText }; };
    await acceptBilibiliEvent({ ...f.body, payload: { kind: 'text', text: '旧模板' } }, f.options.expectedSecret, f.options);
    assert.deepEqual(f.requests[0].parts, [{ type: 'text', text: finalText }]);
    f.options.config.routes[0].event = 'dynamic';
    const dynamic = { ...f.body, live: undefined, payload: { kind: 'text', text: '原始动态' } };
    await acceptBilibiliEvent(dynamic, f.options.expectedSecret, f.options); assert.equal(models, 1);
    assert.deepEqual(f.requests[1].parts, [{ type: 'text', text: '原始动态' }]);
    await assert.rejects(acceptBilibiliEvent(f.body, f.options.expectedSecret, f.options), /non-live/u);
    await assert.rejects(acceptBilibiliEvent({ ...f.body, live: { ...live, uid: '987' } }, f.options.expectedSecret, f.options), /metadata/u);
});
test('captioned image creates one native payload and one durable receipt; caption replay conflict is rejected', async t => {
    const f = fixture(t); const path = join(f.dir, 'card.png'); writeFileSync(path, png); let sends = 0;
    const queue = new DeliveryQueue({ store: f.store, policy: () => f.options.policy, config: async () => ({}), send: async args => {
        sends++; assert.equal(args.payloads.length, 1); assert.equal(args.payloads[0].text, finalText); assert.ok(args.payloads[0].mediaUrl);
        return { status: 'sent', receipt: { primaryPlatformMessageId: 'mock-image-and-text' } };
    } });
    const request = { accountId: 'default', target: { type: 'group', id: '700000011' }, feature: 'conversation', action: 'chat', dedupeKey: 'one-image-and-caption', parts: [{ type: 'image', path, caption: finalText }] };
    await queue.enqueue(request); await queue.enqueue(request); assert.equal(sends, 1);
    await assert.rejects(queue.enqueue({ ...request, parts: [{ ...request.parts[0], caption: '改动内容' }] }), /conflict/u);
    await assert.rejects(queue.enqueue({ ...request, dedupeKey: 'bad-caption', parts: [{ type: 'text', text: 'test', caption: 'bad' }] }), /caption/u);
});

test('upstream patch is idempotent, preserves card renderer and ships one composite plus metadata', { skip: !existsSync(new URL('../integrations/bilibili-notify/runtime/index.mjs', import.meta.url)) }, async () => {
    const source = readFileSync(new URL('../integrations/bilibili-notify/runtime/index.mjs', import.meta.url), 'utf8');
    assert.equal(patchLiveNotify(source), source); assert.throws(() => patchLiveNotify('different upstream version'), /anchor/u);
    const begin = source.indexOf('\tasync sendLiveNotifyCard(params) {'); const end = source.indexOf('\n\t/**', begin);
    const Runtime = new Function(`return class { ${source.slice(begin, end)} }`)(); const runtime = new Runtime();
    let cardCalls = 0; let calls = 0;
    runtime.imageRenderer = { generateLiveCard: async (...args) => { cardCalls++; assert.equal(args[0].title, live.title); return png; } };
    runtime.isDisposed = () => false;
    runtime.contentBuilder = { image: (buffer, mime) => ({ type: 'image', buffer, mime }), text: text => ({ type: 'text', text }), message: segments => segments };
    runtime.push = { broadcastToTargets: async (uid, content, type, options) => {
        calls++; assert.equal(uid, live.uid); assert.equal(type, 3); assert.equal(content.length, 2); assert.deepEqual(content[0].buffer, png);
        assert.deepEqual(options.openclawLive, live);
    } };
    runtime.broadcastWithMessageLayout = async () => assert.fail('must not split live-start message');
    await runtime.sendLiveNotifyCard({ liveType: 1, liveData: {}, liveRoomInfo: { room_id: live.roomId, title: live.title, area_name: live.areaName, live_time: live.startedAt },
        master: { username: live.upName, userface: 'mock-avatar' }, uid: live.uid, notifyMsg: '原始模板', roomLink: 'https://live.bilibili.com/234567',
        messageLayout: { blocks: [{ type: 'card', visible: true }, { type: 'text', visible: true }, { type: 'split', visible: true }] } });
    assert.equal(cardCalls, 1); assert.equal(calls, 1);
    assert.match(source, /payload\.openclawLive \? \{ live: payload\.openclawLive \}/u);
    assert.match(source, /Math\.max\(timeoutMs, 180000\)/u);
});

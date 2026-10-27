import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { syncBilibiliSubscription, bilibiliSubscriptionStatus, createBilibiliClient } from '../src/src/features/bilibili-sync.js';
import { BUSINESS_TOOLS } from '../src/src/features/catalog.js';
import { decideFeatureTool } from '../src/src/feature-tools.js';

async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), 'bili-sync-')); t.after(() => rm(root, { recursive: true, force: true }));
    const secretFile = join(root, 'webhook-secret'); await writeFile(secretFile, 'secret-'.repeat(8));
    const policy = JSON.parse(await readFile('/root/.openclaw/onebot-features.json')); policy.features.bilibili.enabled = true;
    await writeFile(join(root, 'onebot-bilibili.json'), JSON.stringify({ version: 1, enabled: true, secretFile, routes: [] }));
    const state = { subs: [], targets: [], connections: [], calls: [], loggedIn: true, followed: true, fail: null };
    const copy = value => structuredClone(value);
    const merge = (a, b) => { for (const [k,v] of Object.entries(b)) a[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(a[k] ?? {}, v) : copy(v); return a; };
    const client = { call: async (path, body, method = body === undefined ? 'GET' : 'POST') => {
        state.calls.push({ path, method });
        if (state.fail?.(path, body, method)) throw new Error('synthetic disconnect');
        if (path === '/api/auth/status') return { status: state.loggedIn ? 5 : 0 };
        if (path === '/api/subs/lookup?uid=123456') return { name: '测试UP', uid: '123456' };
        if (path === '/api/connections' && method === 'POST') {
            const previous = state.connections.find(c => c.id === body.id);
            if (previous) merge(previous, body); else {
                state.connections.push(copy(body)); state.targets.push({ id: randomUUID(), connectionId: body.id, enabled: true, kind: 'endpoint' });
            }
        } else if (path === '/api/subs' && method === 'POST') {
            const previous = state.subs.find(s => s.id === body.id);
            if (previous) merge(previous, body); else state.subs.push(copy(body));
            state.subs.find(s => s.id === body.id).followed = state.followed;
        } else if (path.startsWith('/api/subs/') && method === 'PATCH') {
            const sub = state.subs.find(s => path.endsWith(s.id)); assert.ok(sub); merge(sub, body); return copy(sub);
        }
        if (path === '/api/subs') return copy(state.subs);
        if (path === '/api/targets') return copy(state.targets);
        if (path === '/api/connections') return copy(state.connections);
        throw new Error('unexpected fake API call: '+method+' '+path);
    } };
    const params = { action: 'add', accountId: 'default', groupId: '700000011', originGroupId: '700000011', uid: '123456', event: 'all' };
    const options = { root, policy, client };
    const config = async () => JSON.parse(await readFile(join(root, 'onebot-bilibili.json')));
    return { root, state, params, options, config, run: changes => syncBilibiliSubscription({ ...params, ...changes }, options) };
}

test('adding by UID creates actual subscriptions, no approval, repeats never duplicate UP or endpoints', async t => {
    const f = await fixture(t); assert.equal(BUSINESS_TOOLS.bilibili_subscribe.approval, false);
    const result = await f.run({}); assert.equal(result.upstreamSynchronized, true); assert.equal(result.followed, true); assert.equal(result.deliveryVerified, false);
    assert.equal(f.state.subs.length, 1); assert.equal(f.state.connections.length, 2); assert.equal((await f.config()).routes.length, 2);
    await f.run({}); assert.equal(f.state.subs.length, 1); assert.equal(f.state.connections.length, 2); assert.equal((await f.config()).routes.length, 2);
    const status = await bilibiliSubscriptionStatus(f.params, f.options); assert.ok(status.subscriptions.every(r => r.synchronized));
});
test('two groups share one UP: cancelling dynamic or all affects only the current group and preserves other settings', async t => {
    const f = await fixture(t); await f.run({});
    await f.run({ groupId: '700000008', originGroupId: '700000008' });
    assert.equal(f.state.subs.length, 1); const secondIds = (await f.config()).routes.filter(r => r.groupId === '700000008').map(r => r.targetId);
    f.state.subs[0].overrides.filters = { blockKeywords: ['keep-this'] };
    const secondStatus = await bilibiliSubscriptionStatus({ ...f.params, groupId: '700000008', originGroupId: '700000008' }, f.options);
    assert.equal(secondStatus.subscriptions.length, 2); assert.doesNotMatch(JSON.stringify(secondStatus), /700000011/u);
    await f.run({ action: 'remove', event: 'dynamic' });
    assert.equal((await f.config()).routes.filter(r => r.groupId === '700000011').length, 1);
    await f.run({ action: 'remove' }); await f.run({ action: 'remove' });
    const sub = f.state.subs[0]; assert.equal(sub.enabled, true); assert.deepEqual(sub.overrides.filters, { blockKeywords: ['keep-this'] });
    assert.ok(secondIds.every(id => sub.routing.dynamic.includes(id) || sub.routing.live.includes(id)));
    assert.equal((await f.config()).routes.length, 2); assert.ok(f.state.calls.every(c => c.method !== 'DELETE'));
    await f.run({ groupId: '700000008', originGroupId: '700000008', action: 'remove' }); assert.equal(sub.enabled, false);
    assert.equal(f.state.subs.length, 1); await f.run({}); assert.equal(sub.enabled, true); assert.equal(f.state.connections.length, 4);
});
test('cancel revokes local delivery before upstream access; retry reconciles without touching other groups', async t => {
    const f = await fixture(t); await f.run({});
    f.state.fail = p => p === '/api/auth/status';
    await assert.rejects(f.run({ action: 'remove' }), /通知已停用.*尚未完成/u);
    assert.ok((await f.config()).routes.every(r => !r.enabled));
    f.state.fail = null; await f.run({ action: 'remove' }); assert.equal((await f.config()).routes.length, 0);
});
test('logged-out, failed-follow and missing-target adds never claim monitoring success or activate new delivery routes', async t => {
    const f = await fixture(t); f.state.loggedIn = false; await assert.rejects(f.run({}), /未登录/u); assert.equal(f.state.connections.length, 0);
    f.state.loggedIn = true; f.state.followed = false; await assert.rejects(f.run({}), /关注未确认/u);
    assert.ok((await f.config()).routes.every(r => !r.enabled));
    f.state.followed = true; await f.run({}); f.state.targets = [];
    await assert.rejects(f.run({}), /目标不可用/u);
});
test('disconnect after applying upstream mutation can be reconciled idempotently with same routes', async t => {
    const f = await fixture(t); let once = true;
    const original = f.options.client.call;
    f.options.client = { call: async (...args) => {
        const result = await original(...args);
        if (once && args[2] === 'PATCH') { once = false; throw new Error('response lost'); }
        return result;
    } };
    await assert.rejects(f.run({}), /response lost/u); assert.ok((await f.config()).routes.every(r => !r.enabled));
    await f.run({}); assert.equal(f.state.subs.length, 1); assert.equal(f.state.connections.length, 2); assert.ok((await f.config()).routes.every(r => r.enabled));
});
test('foreign group, alias takeover, guest and unsafe input are blocked; group defaults are gateway-owned', async t => {
    const f = await fixture(t); await f.run({}); const alias = (await f.config()).routes[0].targetId;
    await assert.rejects(f.run({ groupId: '700000008' }), /已授权群聊/u);
    await assert.rejects(f.run({ targetId: alias, groupId: '700000008', originGroupId: '700000008', action: 'remove' }), /其他群聊/u);
    await assert.rejects(f.run({ uid: '123;cat /root/key' }), /无效/u);
    const context = { scope: 'group', accountId: 'default', groupId: '700000011', senderId: '188888888', explicit: true, roleCount: 1 };
    assert.equal(decideFeatureTool(f.options.policy, 'bilibili_subscribe', {}, context).allowed, false);
    const command = BUSINESS_TOOLS.bilibili_subscribe.build({ action: 'remove', uid: '123456' }, context, f.options.policy);
    assert.equal(JSON.parse(command.argv.at(-1)).groupId, context.groupId);
    assert.throws(() => BUSINESS_TOOLS.bilibili_subscribe.build({ action: 'add', uid: '123456', groupId: '700000008' }, context, f.options.policy));
});
test('cross-process lock never lets a second writer overwrite active synchronization', async t => {
    const f = await fixture(t); const dir = join(f.root, 'state/business/bilibili-sync/lock'); await mkdir(dir, { recursive: true });
    await assert.rejects(f.run({}), /同步正在处理/u); assert.equal(f.state.calls.length, 0);
});
test('legacy all-event alias can cancel one event, including recovery after upstream disconnect', async t => {
    const f = await fixture(t); await f.run({});
    const cfg = await f.config(), route = cfg.routes.find(r => r.event === 'dynamic');
    cfg.routes = [route]; route.event = 'all';
    f.state.subs[0].routing.live = [route.targetId];
    await writeFile(join(f.root, 'onebot-bilibili.json'), JSON.stringify(cfg));
    f.state.fail = p => p === '/api/auth/status';
    await assert.rejects(f.run({ action: 'remove', event: 'dynamic' }), /通知已停用/u);
    const pending = (await f.config()).routes[0]; assert.equal(pending.event, 'all'); assert.equal(pending.enabled, false);
    f.state.fail = null; await f.run({ action: 'remove', event: 'dynamic' });
    const saved = (await f.config()).routes[0]; assert.equal(saved.event, 'live'); assert.equal(saved.enabled, true);
    assert.deepEqual(f.state.subs[0].routing.dynamic, []); assert.deepEqual(f.state.subs[0].routing.live, [route.targetId]);
});
test('fixed client authenticates locally; redirects, response bodies and secrets never become public errors', async t => {
    const root = await mkdtemp(join(tmpdir(), 'bili-client-')); t.after(() => rm(root, { recursive: true, force: true }));
    const dir = join(root, 'onebot-onebot-custom/integrations/bilibili-notify'); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '.env'), 'BN_DASHBOARD_USER=admin\nBN_DASHBOARD_PASS=private-password\n');
    const calls = [];
    const client = await createBilibiliClient({ root, request: async (url, options) => {
        calls.push({ url, options }); assert.equal(options.redirect, 'error'); assert.match(url, /^http:\/\/127\.0\.0\.1:8787\/api\//u);
        return calls.length === 1 ? new Response('{"ok":true}', { headers: { 'set-cookie': 'bn_session=private-cookie; HttpOnly' } })
            : new Response('private-password secret-cookie', { status: 500 });
    } });
    await assert.rejects(client.call('/api/subs'), e => !/private-password|secret-cookie/u.test(e.message));
    assert.equal(calls[1].options.headers.Cookie, 'bn_session=private-cookie');
    await assert.rejects(client.call('http://example.org'), /invalid fixed/u);
});

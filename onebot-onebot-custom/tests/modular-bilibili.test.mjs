import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperationStore } from '../src/src/access/operations.js';
import { acceptBilibiliEvent, validateBilibiliConfig } from '../src/src/features/bilibili.js';
function fixture(t) {
    const dir = mkdtempSync(join(tmpdir(), 'onebot-bili-')); const store = new OperationStore(join(dir, 'operations.sqlite')); t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
    const policy = JSON.parse(readFileSync('/root/.openclaw/onebot-features.json', 'utf8')); policy.features.bilibili.enabled = true;
    const config = { version: 1, enabled: true, routes: [{ targetId: 'up-test-dynamic', uid: '123456', event: 'dynamic', accountId: 'default', groupId: '700000011', enabled: true }] };
    let calls = 0; let request;
    const options = { config, policy, store, expectedSecret: 'a'.repeat(40), queue: { enqueue: async value => { calls++; request = value; return { id: 'offline-delivery', state: 'accepted' }; } } };
    return { options, config, policy, count: () => calls, request: () => request };
}
const event = () => ({ targetId: 'up-test-dynamic', targetName: 'ignored', scope: 'private', private: true, ts: Date.now(), payload: { kind: 'text', text: 'UP 发布了新动态：https://t.bilibili.com/123' } });
test('authenticated upstream alias fixes target; duplicate webhook never creates a second delivery', async t => {
    const f = fixture(t); const body = event(); await acceptBilibiliEvent(body, f.options.expectedSecret, f.options);
    await acceptBilibiliEvent({ ...body, ts: new Date().toISOString() }, f.options.expectedSecret, f.options);
    assert.equal(f.count(), 1); assert.deepEqual(f.request().target, { type: 'group', id: '700000011' }); assert.equal(f.request().context, undefined);
});
test('bad secret, stale/replayed events, unknown aliases and module revoke are rejected', async t => {
    const f = fixture(t);
    await assert.rejects(acceptBilibiliEvent(event(), 'bad', f.options), /unauthorized/u);
    await assert.rejects(acceptBilibiliEvent({ ...event(), ts: Date.now() - 600000 }, f.options.expectedSecret, f.options), /stale/u);
    await assert.rejects(acceptBilibiliEvent({ ...event(), targetId: 'group:99999999' }, f.options.expectedSecret, f.options), /unconfigured/u);
    f.policy.features.bilibili.enabled = false; await assert.rejects(acceptBilibiliEvent(event(), f.options.expectedSecret, f.options), /disabled/u); assert.equal(f.count(), 0);
});
test('SSRF links, fake images and duplicate route aliases fail closed', async t => {
    const f = fixture(t);
    await assert.rejects(acceptBilibiliEvent({ ...event(), payload: { kind: 'link', title: 'test', jumpUrl: 'http://127.0.0.1:9090/configs' } }, f.options.expectedSecret, f.options), /invalid/u);
    await assert.rejects(acceptBilibiliEvent({ ...event(), payload: { kind: 'image', image: { mime: 'image/png', data: Buffer.from('not an image').toString('base64') } } }, f.options.expectedSecret, f.options), /signature/u);
    assert.throws(() => validateBilibiliConfig({ ...f.config, routes: [f.config.routes[0], f.config.routes[0]] })); assert.equal(f.count(), 0);
});

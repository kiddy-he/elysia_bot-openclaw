import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperationStore } from '../src/src/access/operations.js';
import { DeliveryQueue, persistArtifact } from '../src/src/delivery/queue.js';
import { DeliveryLimiter } from '../src/src/delivery/limiter.js';

test('transport limiter caps parallel targets, orders one target and releases a failed lane', async () => {
    const limiter = new DeliveryLimiter(() => ({ maxInFlight: 2, minAccountGapMs: 0, minTargetGapMs: 0 }));
    let running = 0, peak = 0;
    const events = [];
    const send = (id, fail = false) => async () => {
        running++; peak = Math.max(peak, running); events.push(`start:${id}`);
        await new Promise(resolve => setTimeout(resolve, 10));
        running--; events.push(`end:${id}`);
        if (fail) throw new Error('simulated transport failure');
        return id;
    };
    const results = await Promise.allSettled([
        limiter.run('a', 'one', send('first', true)), limiter.run('a', 'one', send('second')),
        limiter.run('a', 'two', send('other')), limiter.run('b', 'three', send('third')),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 3);
    assert.equal(peak, 2); assert.ok(events.indexOf('end:first') < events.indexOf('start:second'));
    assert.equal(limiter.running, 0); assert.equal(limiter.lanes.size, 0); assert.equal(limiter.waiters.length, 0);
});
const original = JSON.parse(readFileSync('/root/.openclaw/onebot-features.json', 'utf8'));
function fixture(t, send) {
    const dir = mkdtempSync(join(tmpdir(), 'onebot-delivery-')); const store = new OperationStore(join(dir, 'operations.sqlite'));
    const policy = structuredClone(original); const queue = new DeliveryQueue({ store, send, policy: () => policy, config: async () => ({}) });
    t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); }); return { dir, store, policy, queue };
}
const receipt = { primaryPlatformMessageId: '12345', platformMessageIds: ['12345'], parts: [{ platformMessageId: '12345', index: 0, kind: 'text' }] };
const request = key => ({ dedupeKey: key, feature: 'conversation', action: 'chat', accountId: 'default', target: { type: 'group', id: '700000011' }, parts: [{ type: 'text', text: 'offline acceptance only' }] });
test('durable producer retains native id and platform receipt, dedupes concurrent replay', async t => {
    let sends = 0; const { queue } = fixture(t, async args => { sends++; assert.equal(args.durability, 'required'); assert.equal(args.reusePendingDeliveryIntent, true); args.onDeliveryIntent({ id: 'native-test' }); return { status: 'sent', receipt }; });
    const results = await Promise.all([queue.enqueue(request('one')), queue.enqueue(request('one'))]);
    assert.equal(sends, 1); assert.ok(results.every(r => r.state === 'accepted')); assert.equal(queue.get(results[0].id).native_id, 'native-test');
    assert.equal((await queue.enqueue(request('one'))).receipt.primaryPlatformMessageId, '12345');
    await assert.rejects(queue.enqueue({ ...request('one'), parts: [{ type: 'text', text: 'different' }] }), /conflict/u);
});
test('send-start crash is uncertain, reopening never blind-resends', async t => {
    let sends = 0; const { queue, store } = fixture(t, async () => { sends++; throw new Error('process died after platform dispatch'); });
    const result = await queue.enqueue(request('crash')); assert.equal(result.state, 'uncertain');
    await queue.recover(); await queue.enqueue(request('crash')); assert.equal(sends, 1);
    store.db.prepare("UPDATE deliveries SET state='dispatching' WHERE id=?").run(result.id);
    await queue.recover(); assert.equal(queue.get(result.id).state, 'uncertain'); assert.equal(sends, 1);
});
test('partial failure remains native-owned with receipts, no local retry worker', async t => {
    let sends = 0; const { queue } = fixture(t, async () => { sends++; return { status: 'partial_failed', receipt, error: new Error('second part timed out') }; });
    const first = await queue.enqueue({ ...request('partial'), parts: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] });
    assert.equal(first.state, 'native_pending'); assert.equal(first.receipt.parts.length, 1);
    await queue.enqueue({ ...request('partial'), parts: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] }); assert.equal(sends, 1);
});
test('approval dependencies persist across reopen and do not block unrelated chat', async t => {
    let sends = 0; const { dir, queue, store } = fixture(t, async () => { sends++; return { status: 'sent', receipt }; });
    const waiting = await queue.enqueue({ ...request('dependent'), approvalIds: ['approval-1'] }); assert.equal(waiting.state, 'waiting_approval');
    assert.equal((await queue.enqueue(request('independent'))).state, 'accepted'); assert.equal(sends, 1);
    const other = new OperationStore(join(dir, 'operations.sqlite')); const restored = new DeliveryQueue({ store: other, send: async () => { sends++; return { status: 'sent', receipt }; }, policy: () => original, config: async () => ({}) });
    await restored.recover(); assert.equal(sends, 1); await restored.resolveApproval('approval-1', true); assert.equal(sends, 2); assert.equal(queue.get(waiting.id).state, 'accepted'); other.close();
});
test('revocation, expiry and denial prevent delayed sends', async t => {
    let sends = 0; const { queue, policy } = fixture(t, async () => { sends++; return { status: 'sent', receipt }; });
    const waiting = await queue.enqueue({ ...request('revoked'), approvalIds: ['a'] }); policy.features.conversation.enabled = false;
    await queue.resolveApproval('a', true); assert.equal(queue.get(waiting.id).state, 'revoked');
    policy.features.conversation.enabled = true;
    assert.equal((await queue.enqueue({ ...request('expired'), expiresAt: Date.now() - 1 })).state, 'expired');
    const denied = await queue.enqueue({ ...request('denied'), approvalIds: ['b'] }); await queue.resolveApproval('b', false); assert.equal(queue.get(denied.id).state, 'denied'); assert.equal(sends, 0);
});
test('durable artifacts survive removal of their temporary source', async t => {
    const { dir, store } = fixture(t, async () => {}); const source = join(dir, 'temporary.png'); writeFileSync(source, 'offline-test-image');
    const persisted = await persistArtifact(source, store, join(dir, 'artifacts')); rmSync(source); assert.equal(existsSync(persisted), true); assert.equal(readFileSync(persisted, 'utf8'), 'offline-test-image');
});
test('corrupted producer metadata is quarantined without blocking recovery or sending', async t => {
    let sends = 0; const { queue, store } = fixture(t, async () => { sends++; return { status: 'sent', receipt }; });
    store.db.prepare('INSERT INTO deliveries VALUES(?,?,?,?,?,NULL,NULL,?,?)').run('corrupt', 'corrupt', null, '{invalid-json', 'ready', Date.now(), Date.now());
    await queue.recover(); assert.equal(queue.get('corrupt').state, 'failed_corrupt'); assert.equal(sends, 0);
});

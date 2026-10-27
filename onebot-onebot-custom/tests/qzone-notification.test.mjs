import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperationStore } from '../src/src/access/operations.js';
import { DeliveryQueue, authorizeDelivery } from '../src/src/delivery/queue.js';
const policy = JSON.parse(readFileSync('/root/.openclaw/onebot-features.json', 'utf8'));
const jobId = '4b13a241-07de-57bb-8d55-7c7fb958b5f3';
const notice = () => ({ scriptService: 'qzone-daily', originJobId: jobId, feature: 'qzone', action: 'publish', accountId: 'default',
  target: { type: 'private', id: policy.accounts.default.privateAdminIds[0] },
  parts: [{ type: 'text', text: '空间图文准备失败，已安排随机重试。' }], dedupeKey: 'qzone-daily:2099-01-01:prepare:daily:1' });

test('Qzone daily notification is limited to the registered private owner, fixed producer, feature and text', () => {
  assert.equal(authorizeDelivery(notice(), policy), true);
  for (const change of [
    { target: { type: 'group', id: '700000011' } }, { target: { type: 'private', id: '12345678' } },
    { accountId: 'yuexia' }, { originJobId: '6d3bc95e-82c6-5cae-b601-93abd91418a6' },
    { feature: 'alas', action: 'control' }, { action: 'read' },
    { parts: [{ type: 'image', path: '/tmp/test.png' }] }, { parts: [{ type: 'text', text: 'x'.repeat(2001) }] },
  ]) assert.throws(() => authorizeDelivery({ ...notice(), ...change }, policy));
  const disabled = structuredClone(policy); disabled.automationBindings[jobId].enabled = false;
  assert.throws(() => authorizeDelivery(notice(), disabled), /revoked/u);
});

test('failure notice uses existing durable queue and replays the receipt without a second private message', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'qzone-notice-'));
  const store = new OperationStore(join(dir, 'operations.sqlite'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  let sends = 0;
  const receipt = { primaryPlatformMessageId: 'simulated-qq-receipt' };
  const queue = new DeliveryQueue({ store, policy: () => policy, config: async () => ({}), send: async () => { sends++; return { status: 'sent', receipt }; } });
  const results = await Promise.all([queue.enqueue(notice()), queue.enqueue(notice())]);
  assert.ok(results.every(result => result.state === 'accepted')); assert.equal(sends, 1);
  assert.equal((await queue.enqueue(notice())).receipt.primaryPlatformMessageId, receipt.primaryPlatformMessageId);
  assert.equal(sends, 1);
});

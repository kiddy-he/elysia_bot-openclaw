import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OperationStore } from '../src/src/access/operations.js';
import { ReminderManager, matchReminderMember, reminderDueAt, authorizeReminderDelivery, reminderPromptContext } from '../src/src/features/reminders.js';
import { DeliveryQueue, authorizeDelivery } from '../src/src/delivery/queue.js';
import { decideFeatureTool } from '../src/src/feature-tools.js';
import { executeBusinessTool } from '../src/src/features/tools.js';
import { sendTextTransport } from '../src/src/outbound.js';
import { createServer } from 'node:http';

const base = JSON.parse(readFileSync('/root/.openclaw/onebot-features.json', 'utf8'));
const member = { accountId: 'default', scope: 'group', groupId: '700000012', senderId: '188888888', requestId: 'reminder-test', explicit: true, roleCount: 1, reminderAction: 'create' };
const people = [{ user_id: 188888888, nickname: '小海', card: '海盐饼干' }, { user_id: 199999999, nickname: 'Alice', card: '爱丽丝今天摸鱼' }];
function fixture(t) {
    const dir = mkdtempSync(join(tmpdir(), 'reminder-test-')), path = join(dir, 'state.sqlite'), store = new OperationStore(path);
    const policy = structuredClone(base); policy.features.reminders ??= { name: '定时提醒', enabled: true, implemented: true, groupIds: base.features.conversation.groupIds,
        accountIds: ['default', 'yuexia'], actions: Object.fromEntries(['create', 'list', 'cancel'].map(a => [a, { enabled: true, profile: 'public' }])) };
    const time = { now: Date.parse('2030-01-01T04:00:00Z') }; let sends = 0, sent;
    const queue = new DeliveryQueue({ store, policy: () => policy, config: async () => ({}), send: async input => { sends++; sent = input; return { status: 'sent', receipt: { primaryPlatformMessageId: 'mock-1000' } }; } });
    const manager = new ReminderManager({ store, policy: () => policy, now: () => time.now, members: async () => people, enqueue: input => queue.enqueue(input) });
    t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
    return { store, path, policy, manager, queue, time, sends: () => sends, sent: () => sent };
}

test('group matching combines account nickname and card, permits partial/typo matches and rejects ambiguity/all', () => {
    for (const q of ['Alice', 'ＡＬＩＣＥ', '爱丽丝', '摸鱼', 'Alicee', '199999999', '@Alice']) assert.equal(matchReminderMember(q, people).member?.id, '199999999', q);
    const two = [...people, { user_id: '177777777', nickname: 'Alice', card: '另一个人' }];
    assert.equal(matchReminderMember('Alice', two).status, 'ambiguous');
    assert.equal(matchReminderMember('爱丽丝', [...people, { user_id: 177777777, card: '爱丽丝明天摸鱼' }]).status, 'ambiguous');
    for (const q of ['all', '全体成员', '未知昵称', '0', 'a']) assert.equal(matchReminderMember(q, people).status, 'not_found');
});
test('relative and Shanghai absolute times are bounded and impossible/past dates rejected', () => {
    const now = Date.parse('2030-01-01T04:00:00Z');
    assert.equal(reminderDueAt({ delaySeconds: 600 }, now - 3000, now), now + 597000);
    assert.equal(reminderDueAt({ dueAt: '2030-01-02T08:00:00+08:00' }, now, now), Date.parse('2030-01-02T00:00:00Z'));
    for (const p of [{}, { delaySeconds: 0 }, { delaySeconds: 999999999 }, { dueAt: '2030-02-30T08:00:00+08:00' }, { dueAt: '2030-01-01T25:00:00+08:00' }, { dueAt: '2030-01-02T08:00:00' }, { dueAt: '2029-01-01T08:00:00Z' }, { delaySeconds: 600, dueAt: '2030-01-02T08:00:00Z' }]) assert.throws(() => reminderDueAt(p, now, now));
});
test('member creates current-group reminder, gets real recipient and durable payload, repeated creation is idempotent', async t => {
    const f = fixture(t), p = { content: '开会啦', delaySeconds: 600, recipient: 'Alice' };
    const first = await f.manager.create(p, member, 'a'.repeat(64));
    const repeat = await f.manager.create(p, member, first.reminderId); assert.equal(first.reminderId, repeat.reminderId);
    await assert.rejects(f.manager.create({ ...p, content: '新内容' }, member), /已经创建/u);
    const row = f.store.db.prepare('SELECT * FROM reminders').get(); const payload = JSON.parse(row.payload);
    assert.equal(payload.recipient.id, '199999999'); assert.equal(payload.deliveryRequest.target.id, '700000012');
    assert.deepEqual(payload.deliveryRequest.parts[0].mentions, ['199999999']);
    assert.throws(() => authorizeReminderDelivery(payload.deliveryRequest, f.policy, f.store, f.time.now), /尚未到期/u);
    assert.equal(f.sends(), 0);
});
test('ambiguous names do not register, private guests can only remind themselves', async t => {
    const f = fixture(t); f.manager.members = async () => [...people, { user_id: 177777777, nickname: 'Alice' }];
    assert.equal((await f.manager.create({ content: '测试', delaySeconds: 60, recipient: 'Alice' }, member)).state, 'needs_recipient');
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM reminders').get().n, 0);
    const visitor = { ...member, scope: 'private', groupId: undefined };
    const task = await f.manager.create({ content: '喝水', delaySeconds: 600 }, visitor);
    assert.equal(task.recipient.id, member.senderId);
    await assert.rejects(f.manager.create({ content: '喝水', delaySeconds: 600, recipient: 'Alice' }, { ...visitor, requestId: 'other' }), /只能发给当前本人/u);
});
test('only creator in original account/conversation can list or cancel; cancelled reminders never send', async t => {
    const f = fixture(t), r = await f.manager.create({ content: '喝水', delaySeconds: 1 }, member);
    assert.equal(f.manager.list(member).length, 1);
    for (const ctx of [{ ...member, senderId: '199999999' }, { ...member, groupId: '700000008' }, { ...member, accountId: 'yuexia', groupId: '700000011' }]) {
        assert.equal(f.manager.list(ctx).length, 0); assert.throws(() => f.manager.cancel(r.reminderId, ctx));
    }
    assert.equal(f.manager.cancel(r.reminderId.slice(0, 12), member).state, 'cancelled');
    f.time.now += 2000; await f.manager.tick(); assert.equal(f.sends(), 0);
});
test('due delivery survives database reopen, exact text and at target remain bound, tick never duplicate-sends', async t => {
    const f = fixture(t), r = await f.manager.create({ content: '开会 [CQ:at,qq=all] $(id)', delaySeconds: 600, recipient: 'Alice' }, member);
    const reopened = new OperationStore(f.path); t.after(() => reopened.close());
    const queued = [];
    const mgr = new ReminderManager({ store: reopened, policy: () => f.policy, now: () => f.time.now, members: async () => people, enqueue: async req => {
        authorizeReminderDelivery(req, f.policy, reopened, f.time.now); queued.push(req); return { id: 'mock-native', state: 'accepted' };
    } });
    await mgr.tick(); assert.equal(queued.length, 0);
    f.time.now += 600001;
    await Promise.all([mgr.tick(), mgr.tick()]); await mgr.tick();
    assert.equal(queued.length, 1); assert.deepEqual(queued[0].parts[0].mentions, ['199999999']);
    assert.equal(queued[0].parts[0].text, '⏰ 提醒：开会 [CQ:at,qq=all] $(id)');
    assert.equal(reopened.db.prepare('SELECT state FROM reminders WHERE id=?').get(r.reminderId).state, 'delivered');
    for (const mutate of [q => { q.parts[0].mentions = ['188888888']; }, q => { q.target.id = '700000008'; }, q => { q.parts[0].text = 'changed'; }]) {
        const q = structuredClone(queued[0]); mutate(q); assert.throws(() => authorizeReminderDelivery(q, f.policy, reopened, f.time.now), /不一致/u);
    }
});
test('departed recipient, revoked feature and expired missed reminders do not send', async t => {
    for (const mode of ['left', 'revoked', 'expired']) {
        const f = fixture(t); const task = await f.manager.create({ content: '测试', delaySeconds: 1, recipient: 'Alice' }, member);
        f.time.now += mode === 'expired' ? 2 * 86400000 : 2000;
        if (mode === 'left') f.manager.members = async () => [people[0]];
        if (mode === 'revoked') f.policy.features.reminders.enabled = false;
        await f.manager.tick(); assert.equal(f.sends(), 0);
        assert.equal(f.store.db.prepare('SELECT state FROM reminders WHERE id=?').get(task.reminderId).state, { left: 'failed', revoked: 'revoked', expired: 'expired' }[mode]);
    }
});
test('corrupt reminder does not block later due tasks; uncertain native intent is not recreated', async t => {
    const f = fixture(t);
    const bad = await f.manager.create({ content: '坏记录', delaySeconds: 1 }, member);
    await f.manager.create({ content: '正常记录', delaySeconds: 1 }, { ...member, requestId: 'second' });
    f.store.db.prepare('UPDATE reminders SET payload=? WHERE id=?').run('invalid-json', bad.reminderId);
    f.time.now += 2000;
    let requests = 0;
    f.manager.enqueue = async () => { requests++; return { id: 'same-native-intent', state: 'uncertain' }; };
    await f.manager.tick(); await f.manager.tick();
    assert.equal(requests, 1);
    assert.equal(f.store.db.prepare('SELECT state FROM reminders WHERE id=?').get(bad.reminderId).state, 'failed_corrupt');
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM reminders WHERE state='queued'").get().n, 1);
});
test('tool permission follows semantic intent and never grants generic execution', t => {
    const f = fixture(t);
    for (const ctx of [member, { ...member, scope: 'private', groupId: undefined }, { ...member, senderId: '700000003' }]) {
        assert.equal(decideFeatureTool(f.policy, 'reminder_create', {}, ctx).allowed, true);
        assert.equal(decideFeatureTool(f.policy, 'reminder_create', {}, { ...ctx, reminderAction: 'none' }).allowed, false);
        assert.equal(decideFeatureTool(f.policy, 'reminder_create', {}, { ...ctx, reminderAction: 'unknown' }).allowed, false);
    }
    assert.equal(decideFeatureTool(f.policy, 'exec', { command: 'true' }, member).allowed, false);
    assert.equal(decideFeatureTool(f.policy, 'reminder_create', {}, { ...member, internal: true }).allowed, false);
    assert.equal(decideFeatureTool(f.policy, 'reminder_list', {}, { ...member, reminderAction: 'cancel' }).allowed, true);
    assert.match(reminderPromptContext(member, ['199999999']), /Asia\/Shanghai/u);
});
test('arbitrary producer cannot add mentions without a registered due reminder', t => {
    const f = fixture(t);
    assert.throws(() => authorizeDelivery({ accountId: 'default', feature: 'conversation', action: 'chat', target: { type: 'group', id: '700000012' }, parts: [{ type: 'text', text: 'x', mentions: ['199999999'] }] }, f.policy, { store: f.store }), /registered reminder/u);
});
test('actual reminder business tools persist/replay/list/cancel for guests without shell or approval', async t => {
    const f = fixture(t);
    for (const scope of ['group', 'private']) for (const accountId of ['default', 'yuexia']) {
        const ctx = { ...member, accountId, scope, groupId: scope === 'group' ? '700000011' : undefined, requestId: `${scope}-${accountId}`, receivedAt: Date.now(), reminderAction: 'create' };
        const input = { name: 'reminder_create', params: { content: '喝水', delaySeconds: 600 }, context: ctx, sessionKey: `${scope}:${accountId}`, callId: 'call-1', store: f.store,
            reminderMembers: async () => people, run: async () => assert.fail('no shell or child process') };
        const first = await executeBusinessTool(input); assert.equal(first.details.status, 'succeeded'); assert.equal(first.details.state, 'scheduled');
        assert.equal((await executeBusinessTool({ ...input, callId: 'call-2' })).details.reminderId, first.details.reminderId);
        const listing = await executeBusinessTool({ ...input, name: 'reminder_list', params: {}, context: { ...ctx, reminderAction: 'list', requestId: ctx.requestId + '-list' } });
        assert.equal(listing.details.reminders.length, 1);
        const cancel = await executeBusinessTool({ ...input, name: 'reminder_cancel', params: { reminderId: first.details.reminderId }, context: { ...ctx, reminderAction: 'cancel', requestId: ctx.requestId + '-cancel' } });
        assert.equal(cancel.details.state, 'cancelled');
    }
});
test('due reminder traverses the real queue and transport as QQ at + text segments with one receipt', async t => {
    const f = fixture(t), requests = [];
    const server = createServer(async (req, res) => {
        const chunks = []; for await (const c of req) chunks.push(c);
        requests.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 123456 } }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
    const queue = new DeliveryQueue({ store: f.store, policy: () => f.policy, config: async () => ({}), send: async input => {
        const row = queue.get(input.deliveryIntentId), request = JSON.parse(row.request), part = request.parts[0];
        const account = { accountId: 'default', config: {}, httpUrl: `http://127.0.0.1:${server.address().port}`, deliveryAdmission: () => { authorizeReminderDelivery(request, f.policy, f.store); return part; } };
        const result = await sendTextTransport({ to: input.to, text: part.text, account, mentions: part.mentions, rewritePersona: false, durableRendered: true });
        assert.equal(result.error, undefined); return { status: 'sent', receipt: { primaryPlatformMessageId: result.messageId } };
    } });
    f.time.now = Date.now() - 10000;
    const p = { ...member, receivedAt: f.time.now };
    await f.manager.create({ content: '开会 [CQ:at,qq=all]', delaySeconds: 1, recipient: 'Alice' }, p);
    f.time.now = Date.now(); f.manager.enqueue = input => queue.enqueue(input);
    await f.manager.tick(); await f.manager.tick();
    assert.equal(requests.length, 1); assert.equal(requests[0].path, '/send_group_msg');
    assert.deepEqual(requests[0].body.message, [{ type: 'at', data: { qq: '199999999' } }, { type: 'text', data: { text: ' ' } }, { type: 'text', data: { text: '⏰ 提醒：开会 [CQ:at,qq=all]' } }]);
    assert.equal(f.store.db.prepare('SELECT state FROM reminders').get().state, 'delivered');
});

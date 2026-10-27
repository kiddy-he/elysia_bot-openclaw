import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperationStore } from '../src/src/access/operations.js';
import { BUSINESS_TOOLS, validateToolParams } from '../src/src/features/catalog.js';
import { executeBusinessTool, registerBusinessTools, setBusinessApprovalReviewer, setBusinessApprovalHandler, resolveBusinessApproval } from '../src/src/features/tools.js';
import { bindFeatureTurn } from '../src/src/feature-tools.js';

const owner = { senderId: '700000003', accountId: 'default', scope: 'group', groupId: '700000011', explicit: true, roleCount: 1, requestId: 'qzone-original-request' };
const params = { action: 'reply', target: '700000006', tid: 'synthetic-post123', commentId: '2', replyUin: '1807533371', content: '谢谢这份心意♪' };
function fixture(t) {
    const dir = mkdtempSync(join(tmpdir(), 'qzone-approval-'));
    const store = new OperationStore(join(dir, 'operations.sqlite'));
    t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
    return { dir, store };
}
const input = store => ({ name: 'qzone_interact', params, context: owner, callId: 'first', sessionKey: 'qzone-test', store });

test('native reply catalog builds the fixed reply CLI and rejects legacy mentions or incomplete parent targets', () => {
    const command = BUSINESS_TOOLS.qzone_interact.build(validateToolParams(BUSINESS_TOOLS.qzone_interact, params), owner);
    assert.equal(command.argv[1], 'reply');
    assert.equal(command.argv[command.argv.indexOf('--comment-id') + 1], '2');
    assert.equal(command.argv[command.argv.indexOf('--reply-uin') + 1], params.replyUin);
    for (const change of [{ commentId: undefined }, { replyUin: undefined }, { content: '@{uin:1807533371,nick:测试}回复' }, { action: 'comment' }])
        assert.throws(() => BUSINESS_TOOLS.qzone_interact.build({ ...params, ...change }, owner), /reply|艾特/u);
});

test('reworded retries of a pending approval never create another operation or inherit approval', async t => {
    const { store } = fixture(t), original = input(store);
    const first = await executeBusinessTool(original);
    const op = store.get(first.details.operationId); store.state(op.id, 'waiting_approval');
    store.approve(op.id, op.fingerprint, 'allow-once');
    await assert.rejects(executeBusinessTool({ ...original, callId: 'model-retry', params: { ...params, content: '改写一遍再次回复' } }), /未创建新审批或重复发送/u);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM operations').get().n, 1);
    let sends = 0;
    const result = await executeBusinessTool({ ...original, run: async () => { sends++; return { stdout: '{"nativeReply":true}' }; } });
    assert.equal(result.details.status, 'succeeded'); assert.equal(sends, 1);
});

test('the same target stays deduplicated across new messages and store reopen while other comments are independent', async t => {
    const { dir, store } = fixture(t), original = input(store);
    const first = await executeBusinessTool(original), op = store.get(first.details.operationId);
    store.approve(op.id, op.fingerprint, 'allow-once');
    await executeBusinessTool({ ...original, run: async () => ({ stdout: 'native reply verified' }) });
    const reopened = new OperationStore(join(dir, 'operations.sqlite'));
    t.after(() => reopened.close());
    await assert.rejects(executeBusinessTool({ ...original, store: reopened, context: { ...owner, requestId: 'new-request' }, callId: 'new-call' }), /succeeded/u);
    const next = await executeBusinessTool({ ...original, params: { ...params, commentId: '1', replyUin: '2083265281' }, callId: 'other-comment' });
    assert.notEqual(next.details.operationId, op.id);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM operations').get().n, 2);
});

test('uncertain native writes block fresh requests even when their text changes', async t => {
    const { store } = fixture(t), original = input(store);
    const first = await executeBusinessTool(original), op = store.get(first.details.operationId);
    store.approve(op.id, op.fingerprint, 'allow-once');
    const uncertain = await executeBusinessTool({ ...original, run: async () => { throw new Error('lost upstream receipt'); } });
    assert.equal(uncertain.details.status, 'uncertain');
    await assert.rejects(executeBusinessTool({ ...original, context: { ...owner, requestId: 'retry-request' }, params: { ...params, content: '再发一次' } }), /uncertain/u);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM operations').get().n, 1);
});

test('a root comment cannot bypass dedupe in the same message by changing its wording', async t => {
    const { store } = fixture(t);
    const original = { ...input(store), params: { action: 'comment', target: params.target, tid: params.tid, content: '一级评论' } };
    await executeBusinessTool(original);
    await assert.rejects(executeBusinessTool({ ...original, callId: 'rewritten', params: { ...original.params, content: '一级评论换措辞' } }), /未创建新审批/u);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM operations').get().n, 1);
});

test('Qzone manual approval returns before slow delivery, queues once, and runs only after exact confirmation', async t => {
    const { store } = fixture(t), hooks = {}, sessionKey = 'qzone-test-hook';
    const releaseTurn = bindFeatureTurn(sessionKey, owner); t.after(releaseTurn);
    registerBusinessTools({ registerTool() {}, on(name, hook) { hooks[name] = hook; }, logger: { error() {} } }, { getStore: () => store });
    let deliveries = 0, releaseDelivery, request;
    setBusinessApprovalReviewer(async () => { throw new Error('manual-only interactions must not wait for quorum'); });
    setBusinessApprovalHandler(owner.accountId, async value => { request = value; deliveries++; await new Promise(resolve => { releaseDelivery = resolve; }); });
    t.after(() => { setBusinessApprovalReviewer(undefined); setBusinessApprovalHandler(owner.accountId, undefined); });
    const event = { toolName: 'qzone_interact', toolCallId: 'initial-call', params };
    const blocked = await hooks.before_tool_call(event, { sessionKey });
    assert.equal(blocked.block, true); assert.match(blocked.blockReason, /尚未执行/u); assert.equal(deliveries, 1);
    assert.equal(store.get(request.operationId).state, 'waiting_approval');
    const again = await hooks.before_tool_call({ ...event, toolCallId: 'retry-call' }, { sessionKey });
    assert.equal(again.block, true);
    const changed = await hooks.before_tool_call({ ...event, toolCallId: 'reworded-call', params: { ...params, content: '换措辞重试' } }, { sessionKey });
    assert.equal(changed.block, true); assert.equal(deliveries, 1);
    releaseDelivery(); await Promise.resolve();
    let sends = 0;
    const done = await resolveBusinessApproval(request.id, true, owner, { store, run: async () => { sends++; return { stdout: 'verified nested reply' }; } });
    assert.equal(done.status, 'succeeded'); assert.equal(sends, 1);
    await assert.rejects(resolveBusinessApproval(request.id, true, owner, { store }), /不存在/u);
});

test('failed approval delivery never executes a reply or creates another approval on retry', async t => {
    const { store } = fixture(t), hooks = {}, sessionKey = 'qzone-failed-delivery';
    const releaseTurn = bindFeatureTurn(sessionKey, owner); t.after(releaseTurn);
    const errors = []; let deliveries = 0;
    registerBusinessTools({ registerTool() {}, on(name, hook) { hooks[name] = hook; }, logger: { error: message => errors.push(message) } }, { getStore: () => store });
    setBusinessApprovalHandler(owner.accountId, async () => { deliveries++; throw new Error('transport disconnect'); });
    t.after(() => setBusinessApprovalHandler(owner.accountId, undefined));
    const event = { toolName: 'qzone_interact', toolCallId: 'first', params };
    await hooks.before_tool_call(event, { sessionKey });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await hooks.before_tool_call({ ...event, toolCallId: 'retry' }, { sessionKey });
    assert.equal(deliveries, 1); assert.equal(errors.length, 1);
    const op = store.db.prepare('SELECT * FROM operations').get();
    assert.equal(op.state, 'waiting_approval');
    const result = await executeBusinessTool({ ...input(store), callId: 'first', sessionKey });
    assert.equal(result.details.status, 'not_executed');
});

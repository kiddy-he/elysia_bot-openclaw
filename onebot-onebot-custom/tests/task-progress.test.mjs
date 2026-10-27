import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskProgress, toolProgressState, bindTaskProgress, registerTaskProgressHooks } from '../src/src/task-progress.js';
import { bindFeatureTurn } from '../src/src/feature-tools.js';

const flush = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
function fixture(t, extra = {}) {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
    const sent = [];
    const progress = createTaskProgress({ softMs: 100, hardMs: 350, send: async text => sent.push(text), ...extra });
    t.after(() => progress.cancel());
    return { sent, progress, tick: async ms => { t.mock.timers.tick(ms); await flush(); } };
}
test('first waiting deadline reports confirmed work and lets the original run complete once', async t => {
    const f = fixture(t); let executions = 0;
    f.progress.record('a', 'quota_query', 'completed');
    const original = new Promise(resolve => setTimeout(() => { executions++; resolve('额度剩余75%'); }, 240));
    const waiting = Promise.race([original, f.progress.deadline]);
    await f.tick(100); assert.equal(f.sent.length, 1); assert.match(f.sent[0], /已确认完成的步骤：查询额度/u);
    assert.equal(executions, 0); await f.tick(140); assert.equal(await waiting, '额度剩余75%');
    await f.progress.finish(); assert.match(f.progress.finalText('额度剩余75%'), /本次处理汇总[\s\S]*额度剩余75%/u);
    const count = f.sent.length; await f.tick(1000); assert.equal(f.sent.length, count); assert.equal(executions, 1);
});
test('hard deadline terminates waiting, preserves failures and never claims an uncertain write succeeded', async t => {
    const f = fixture(t); f.progress.record('a', 'qzone_publish', 'uncertain'); f.progress.record('b', 'quota_query', 'failed');
    const ended = assert.rejects(f.progress.deadline, { code: 'TASK_DEADLINE' });
    await f.tick(350); await ended; await f.progress.finish();
    assert.match(f.progress.timeoutText(), /整体结果尚未确认完成/u); assert.match(f.progress.timeoutText(), /结果尚不确定的步骤：处理空间发布/u);
    assert.doesNotMatch(f.progress.timeoutText(), /已确认完成的步骤/u);
    f.progress.record('a', 'qzone_publish', 'completed'); assert.doesNotMatch(f.progress.timeoutText(), /已确认完成的步骤/u);
});
test('fast completion, reset and cancellation produce no stale progress', async t => {
    const f = fixture(t); await f.tick(50); await f.progress.finish(); await f.tick(500);
    assert.equal(f.sent.length, 0); assert.equal(f.progress.finalText('完成'), '完成');
});
test('a failed progress delivery never aborts or repeats the task', async t => {
    let failures = 0; const f = fixture(t, { send: async () => { throw new Error('transport'); }, onError: () => failures++ });
    await f.tick(100); assert.equal(failures, 1); await f.progress.finish(); assert.equal(f.progress.extended, true);
});
test('a progress message already in flight completes before the final summary', async t => {
    const order = []; let release;
    const f = fixture(t, { send: async () => { order.push('progress-start'); await new Promise(resolve => { release = resolve; }); order.push('progress-end'); } });
    await f.tick(100); const finished = f.progress.finish().then(() => order.push('final'));
    await flush(); assert.deepEqual(order, ['progress-start']); release(); await finished;
    assert.deepEqual(order, ['progress-start', 'progress-end', 'final']);
});
test('reports never copy arbitrary arguments, credentials, error bodies or an unknown tool name', async t => {
    const f = fixture(t); f.progress.record('a', 'exec', 'completed'); f.progress.record('b', '/root/secret sk-private', 'completed');
    await f.tick(100); assert.match(f.sent[0], /执行脚本步骤/u); assert.doesNotMatch(f.sent.join(''), /\/root|sk-private/u);
    assert.equal(toolProgressState({ result: { content: [{ type: 'text', text: 'all done' }] } }), 'unconfirmed');
    assert.equal(toolProgressState({ result: { details: { status: 'running', sessionId: 'private' } } }), 'running');
    assert.equal(toolProgressState({ result: { details: { status: 'succeeded', output: 'secret' } } }), 'completed');
    assert.equal(toolProgressState({ result: { details: { status: 'uncertain' } } }), 'uncertain');
    assert.equal(toolProgressState({ result: { isError: true } }), 'failed');
    assert.equal(toolProgressState({ toolName: 'read', result: { content: [{ type: 'text', text: '{"status":"succeeded"}' }] } }), 'unconfirmed');
});
test('tool hooks bind results to the actual sender, account and current request only', async t => {
    const f = fixture(t), hooks = {}, session = 'agent:main:onebot:test-progress';
    registerTaskProgressHooks({ on: (name, callback) => { hooks[name] = callback; } });
    const context = { senderId: '700000003', accountId: 'default', requestId: 'current', scope: 'private', explicit: true, roleCount: 1 };
    const release = bindFeatureTurn(session, context), unbind = bindTaskProgress(session, context, f.progress);
    t.after(() => { release(); unbind(); });
    hooks.after_tool_call({ toolCallId: 'bad', toolName: 'qzone_publish', result: { details: { status: 'succeeded' } } }, { sessionKey: session, requester: { senderId: 'other' } });
    hooks.after_tool_call({ toolCallId: 'old', toolName: 'qzone_publish', result: { details: { status: 'succeeded' } } }, { sessionKey: session });
    hooks.before_tool_call({ toolCallId: 'good', toolName: 'quota_query', params: {} }, { sessionKey: session });
    hooks.after_tool_call({ toolCallId: 'good', toolName: 'quota_query', result: { details: { status: 'succeeded' } } }, { sessionKey: session });
    await f.tick(100); assert.match(f.sent[0], /查询额度/u); assert.doesNotMatch(f.sent[0], /处理空间发布/u);
});

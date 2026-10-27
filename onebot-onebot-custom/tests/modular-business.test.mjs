import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperationStore } from '../src/src/access/operations.js';
import { BUSINESS_TOOLS, validateToolParams, safeMedia } from '../src/src/features/catalog.js';
import { executeBusinessTool, redactResult, registerBusinessTools, setBusinessApprovalReviewer, pendingBusinessApprovals, resolveBusinessApproval, businessMediaAuthorization } from '../src/src/features/tools.js';
import { trustedServiceContext, authorizeServiceTool } from '../src/src/access/services.js';
import { automationReminder, alasStop } from '../src/src/features/commands.js';
import { bindFeatureTurn, decideFeatureTool } from '../src/src/feature-tools.js';
const policy = JSON.parse(readFileSync('/root/.openclaw/onebot-features.json', 'utf8'));
const owner = { senderId: '700000003', accountId: 'default', scope: 'group', groupId: '700000011', explicit: true, roleCount: 1 };
function fixture(t) { const dir = mkdtempSync(join(tmpdir(), 'onebot-operation-')); const store = new OperationStore(join(dir, 'operations.sqlite')); t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); }); return { dir, store }; }
test('dedicated ADS-B still works when Qzone disables raw host tools', () => {
    const config = structuredClone(policy); config.features.qzone.enabled = false;
    assert.equal(decideFeatureTool(config, 'adsb_query', { query: 'health' }, owner).allowed, true);
    assert.equal(decideFeatureTool(config, 'exec', { command: 'true' }, owner).allowed, false);
    assert.equal(decideFeatureTool(config, 'adsb_query', { query: 'health' }, { ...owner, senderId: '12345678' }).allowed, false);
    assert.equal(decideFeatureTool(config, 'quota_query', {}, { ...owner, senderId: '12345678' }).allowed, true);
});
test('safe dedicated reads can be granted by configuration without granting shell', () => {
    const config = structuredClone(policy); config.features.adsb.actions.read.profile = 'group-public';
    const guest = { ...owner, senderId: '12345678', explicit: false, roleCount: 2 };
    assert.equal(decideFeatureTool(config, 'adsb_query', { query: 'health' }, guest).allowed, true);
    assert.equal(decideFeatureTool(config, 'exec', { command: 'true' }, guest).allowed, false);
    assert.equal(decideFeatureTool(config, 'image_generate', {}, owner).allowed, false);
    assert.equal(decideFeatureTool(config, 'onebot_image_generate', { prompt: 'flower' }, guest).allowed, false);
});
test('catalog rejects shell, identity injection, unsafe integers and extra arguments', () => {
    for (const params of [{ query: 'health; id' }, { query: 'health', senderId: '700000003' }, { query: 'recent', minutes: 1.5 }, { query: 'tracks', icao: 'ABCDEF;cat /etc/passwd' }]) assert.throws(() => validateToolParams(BUSINESS_TOOLS.adsb_query, params));
    const command = BUSINESS_TOOLS.onebot_image_generate.build({ prompt: 'hello; $(touch /tmp/never)\n`id`' });
    assert.equal(command.file, '/bin/bash'); assert.equal(command.argv.at(-1), 'hello; $(touch /tmp/never)\n`id`');
});
test('operation identity caches success and detects changed arguments', async t => {
    const { store } = fixture(t); let calls = 0;
    const input = { name: 'adsb_query', params: { query: 'health' }, context: owner, callId: 'call-1', sessionKey: 'test', store,
        run: async (file, argv, options) => { calls++; assert.equal(options.shell, false); assert.equal(argv.at(-1), 'health'); return { stdout: '{"ok":true}' }; } };
    assert.equal((await executeBusinessTool(input)).details.status, 'succeeded');
    assert.equal((await executeBusinessTool(input)).details.status, 'succeeded'); assert.equal(calls, 1);
    await assert.rejects(executeBusinessTool({ ...input, params: { query: 'stats' } }), /conflict/u);
});
test('repeated model call ids in one incoming message share a single operation', async t => {
    const { store } = fixture(t); let calls = 0;
    const input = { name: 'adsb_query', params: { query: 'health' }, context: { ...owner, requestId: 'incoming-1' }, sessionKey: 'test-same-message', store,
        run: async () => { calls++; return { stdout: 'ok' }; } };
    const first = await executeBusinessTool({ ...input, callId: 'model-call-a' });
    const second = await executeBusinessTool({ ...input, callId: 'model-call-b' });
    assert.equal(first.details.operationId, second.details.operationId); assert.equal(calls, 1);
});
test('controls cannot execute without exact, unexpired one-use approval', async t => {
    const { store } = fixture(t); let calls = 0;
    const input = { name: 'network_control', params: { action: 'restart' }, context: owner, callId: 'write-1', sessionKey: 'test', store,
        run: async () => { calls++; return { stdout: 'done' }; } };
    const denied = await executeBusinessTool(input); assert.equal(denied.details.status, 'not_executed'); assert.equal(calls, 0);
    const op = store.get(denied.details.operationId); assert.throws(() => store.approve(op.id, 'wrong', 'allow-once'));
    store.approve(op.id, op.fingerprint, 'allow-once', Date.now() - 1);
    assert.equal((await executeBusinessTool(input)).details.status, 'not_executed');
    store.approve(op.id, op.fingerprint, 'allow-once'); assert.equal((await executeBusinessTool(input)).details.status, 'succeeded');
    assert.equal(store.consumeApproval(op.id, op.fingerprint), false); assert.equal(calls, 1);
});
test('write timeout stays uncertain and cannot re-execute on replay or reopen', async t => {
    const { dir, store } = fixture(t);
    const input = { name: 'qzone_publish', params: { action: 'delete', tid: 'test-tid-12345' }, context: owner, callId: 'write-timeout', sessionKey: 'test', store };
    const denied = await executeBusinessTool(input); const op = store.get(denied.details.operationId); store.approve(op.id, op.fingerprint, 'allow-once');
    let calls = 0; input.run = async () => { calls++; throw Object.assign(new Error('timeout'), { killed: true }); };
    assert.equal((await executeBusinessTool(input)).details.status, 'uncertain');
    const second = new OperationStore(join(dir, 'operations.sqlite'));
    assert.equal((await executeBusinessTool({ ...input, store: second })).details.status, 'uncertain'); second.close(); assert.equal(calls, 1);
    await assert.rejects(executeBusinessTool({ ...input, callId: 'new-message-retry' }), /不确定/u);
});
test('group media permission is tied to the exact incoming request and sender', async t => {
    const { dir, store } = fixture(t); const context = { ...owner, requestId: 'screenshot-request' };
    const source = join(dir, 'screen.png'); writeFileSync(source, 'synthetic-local-artifact-' + Date.now());
    const result = await executeBusinessTool({ name: 'alas_screenshot', params: {}, context, callId: 'capture-1', sessionKey: 'group-media', store,
        run: async () => ({ stdout: `STATUS=ok\nPATH=${source}\n` }) });
    assert.equal(result.details.status, 'succeeded');
    const managed = /^PATH=(.+)$/mu.exec(result.details.output)[1];
    t.after(() => rmSync(managed, { force: true }));
    assert.match(managed, /media\/outbound\/onebot\//u); assert.equal(readFileSync(managed, 'utf8'), readFileSync(source, 'utf8'));
    assert.equal(businessMediaAuthorization('group-media', managed, context, store).feature, 'alas');
    assert.equal(businessMediaAuthorization('group-media', managed, { ...context, requestId: 'another-message' }, store), null);
    assert.equal(businessMediaAuthorization('group-media', managed, { ...context, senderId: '12345678' }, store), null);
});
test('media grants reject other files and symlink escapes', t => {
    const { dir } = fixture(t); const image = join(dir, 'one.png'); const link = join(dir, 'link.png'); writeFileSync(image, 'test'); symlinkSync(image, link);
    assert.equal(safeMedia(image, { mediaPaths: [image] }), image);
    assert.throws(() => safeMedia(image, { mediaPaths: [] })); assert.throws(() => safeMedia(link, { mediaPaths: [link] }));
});
test('credentials are filtered before persistence and public results', () => {
    const result = redactResult('api_key=sk-abcdefghijklmnopqrstuvwxyz password=secret Authorization: Bearer-secret cookie=abcd');
    assert.doesNotMatch(result, /abcdefghijklmnopqrstuvwxyz|password=secret|Bearer-secret|cookie=abcd/u);
});
test('manual approvals survive reopen, bind actor scope and parameters, execute once', async t => {
    const { dir, store } = fixture(t); let calls = 0;
    const input = { name: 'network_control', params: { action: 'restart' }, context: owner, callId: 'manual-1', sessionKey: 'test-manual', store };
    const first = await executeBusinessTool(input); const op = store.get(first.details.operationId); store.state(op.id, 'waiting_approval');
    const other = new OperationStore(join(dir, 'operations.sqlite'));
    assert.equal(pendingBusinessApprovals(other).length, 1);
    const id = `business-${op.id}`;
    await assert.rejects(resolveBusinessApproval(id, true, { ...owner, groupId: '700000008' }, { store: other }), /不一致/u);
    await assert.rejects(resolveBusinessApproval(id, true, { ...owner, senderId: '12345678' }, { store: other }), /不一致/u);
    const result = await resolveBusinessApproval(id, true, owner, { store: other, run: async () => { calls++; return { stdout: 'offline success' }; } });
    assert.equal(result.status, 'succeeded'); assert.equal(calls, 1);
    await assert.rejects(resolveBusinessApproval(id, true, owner, { store: other }), /不存在/u); other.close();
});
test('manual cancellation and expired approvals never execute controls', async t => {
    const { store } = fixture(t);
    for (const [callId, expired] of [['cancel', false], ['expired', true]]) {
        const first = await executeBusinessTool({ name: 'network_control', params: { action: 'stop' }, context: owner, callId, sessionKey: 'manual', store });
        store.state(first.details.operationId, 'waiting_approval');
        if (expired) store.db.prepare('UPDATE operations SET created=0 WHERE id=?').run(first.details.operationId);
        const resolve = () => resolveBusinessApproval(`business-${first.details.operationId}`, !expired, owner, { store, run: async () => { throw new Error('must never execute'); } });
        if (expired) await assert.rejects(resolve(), /过期/u);
        else assert.equal((await resolveBusinessApproval(`business-${first.details.operationId}`, false, owner, { store })).status, 'denied');
    }
});
test('cron identity derives from registered public agent and job capability, never from user params', () => {
    const id = '9b8c8f4c-8f29-53ac-8db8-681b074815ec';
    const context = trustedServiceContext(`agent:qq-auto-elysia-normal-main:cron:${id}:run:test`);
    assert.equal(context.actorType, 'service'); assert.equal(context.senderId, undefined);
    assert.equal(context.requestId, `agent:qq-auto-elysia-normal-main:cron:${id}:run:test`);
    assert.notEqual(context.requestId, trustedServiceContext(`agent:qq-auto-elysia-normal-main:cron:${id}:run:another`).requestId);
    assert.equal(authorizeServiceTool(context, BUSINESS_TOOLS.rewards_summary), true);
    for (const tool of ['qzone_publish', 'network_control', 'rewards_control', 'adsb_query']) assert.equal(authorizeServiceTool(context, BUSINESS_TOOLS[tool]), false);
    assert.equal(trustedServiceContext(`agent:main:cron:${id}`), null);
    assert.equal(trustedServiceContext('agent:qq-auto-elysia-normal-main:cron:00000000-0000-0000-0000-000000000000'), null);
});
test('new reminder starts disabled, gains a bounded grant, then enables; no command payload', async () => {
    const calls = [], id = '00000000-0000-0000-0000-000000000001';
    const result = await automationReminder({ action: 'create', name: 'offline-acceptance', message: '测试提醒', cron: '15 12 * * 1-5', accountId: 'default', groupId: '700000011' },
        { runCli: async args => { calls.push(args); return args.includes('add') ? { id } : {}; }, writeBinding: async (key, binding) => { assert.equal(key, id); calls.push(binding); } });
    assert.equal(result.status, 'enabled'); assert.ok(calls[0].includes('--disabled')); assert.ok(!calls[0].includes('--command')); assert.ok(calls[0].includes('qq-auto-elysia-normal-helper'));
    assert.equal(calls[0][calls[0].indexOf('--tools') + 1], 'tts_synthesize'); assert.deepEqual(JSON.parse(calls[2][calls[2].indexOf('--params') + 1]).patch.payload.toolsAllow, ['tts_synthesize']); assert.deepEqual(calls[3], ['cron', 'enable', id]);
    await assert.rejects(automationReminder({ action: 'create', name: 'bad', message: 'x', cron: '* * * * *', accountId: 'default', groupId: '700000011' }), /bounded/u);
});
test('multi-character reference uses fixed multi-reference executor', () => {
    assert.equal(BUSINESS_TOOLS.image_reference.build({ character: '崩坏3 爱莉希雅，崩坏3 月下初拥', prompt: '花园合照' }).argv[1], 'official-image-generate-multi');
});

test('a write wrapper exiting after an upstream disconnect cannot be retried as a new request', async t => {
    const { store } = fixture(t); let calls = 0;
    const input = { name: 'network_control', params: { action: 'restart' }, context: { ...owner, requestId: 'disconnect' }, sessionKey: 'write-disconnect', callId: 'first', store,
        run: async () => { calls++; const error = new Error('upstream connection closed after request'); error.code = 1; throw error; } };
    const pending = await executeBusinessTool(input); const op = store.get(pending.details.operationId); store.approve(op.id, op.fingerprint, 'allow-once');
    assert.equal((await executeBusinessTool(input)).details.status, 'uncertain');
    await assert.rejects(executeBusinessTool({ ...input, context: { ...input.context, requestId: 'please-retry' }, callId: 'new-call' }), /不确定/u);
    assert.equal(calls, 1);
});

test('quota business tools expose only selected window facts and a persona reply instruction', async t => {
    const { store } = fixture(t);
    const stdout = 'account_count=1\naccount_1 forbidden=false disabled=false subscription_tier=PRO model_count=2\naccount_1 model=gemini-3.8-flash-high remaining=0% reset=unknown\naccount_1 model=gemini-3.5-flash-lite remaining=90% reset=unknown\naccount_1 quota_group=Gemini Models bucket=gemini-5h remaining=84.52% reset=unknown\naccount_1 quota_group=Gemini Models bucket=gemini-weekly remaining=0.13% reset=unknown\nemail=private@example.com\n';
    for (const name of ['quota_query', 'quota_refresh']) {
        const value = (await executeBusinessTool({ name, params: {}, context: owner, callId: 'quota-test-' + name, sessionKey: 'quota-focused-test', store,
            run: async () => ({ stdout: (name === 'quota_refresh' ? 'refresh_http=200\nrefresh_total=1\nrefresh_success=1\nrefresh_failed=0\n' : '') + stdout }) })).details;
        assert.equal(value.status, 'succeeded');
        assert.match(value.output, /5小时配额：剩余 84\.52%/u);
        assert.match(value.output, /周配额：剩余 0\.13%/u);
        assert.doesNotMatch(value.output, /gemini-3.5-flash-lite|email|private@example|subscription_tier/u);
        assert.match(value.replyInstruction, /当前角色人设/u);
    }
});

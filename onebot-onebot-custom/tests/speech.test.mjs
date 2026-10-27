import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUSINESS_TOOLS, validateToolParams } from '../src/src/features/catalog.js';
import { decideFeatureTool } from '../src/src/feature-tools.js';
import { executeBusinessTool, businessMediaAuthorization, speechDeliveryForTurn, speechFallbackForTurn } from '../src/src/features/tools.js';
import { resolveSpeechTarget, resolveConversationSpeechTarget } from '../src/src/features/speech.js';
import { OperationStore } from '../src/src/access/operations.js';
import { recordSpeechFailure } from '../src/src/features/speech-diagnostics.js';
const policy = JSON.parse(readFileSync('/root/.openclaw/onebot-features.json', 'utf8'));
const base = { senderId: '700000003', accountId: 'default', scope: 'private', requestId: 'speech-1' };

test('only Elysia has speech for admin/member/visitor across scopes; host tools remain denied', () => {
    let count = 0;
    for (const accountId of ['default', 'yuexia']) for (const scope of ['group', 'private']) for (const senderId of ['700000003', '188888888'])
        for (const explicit of [true, false]) for (const roleCount of [1, 2]) {
            const context = { ...base, accountId, scope, senderId, explicit, roleCount, groupId: '700000011' };
            assert.equal(decideFeatureTool(policy, 'tts_synthesize', {}, context).allowed, accountId === 'default');
            if (senderId !== base.senderId) for (const tool of ['exec', 'read', 'write', 'message', 'adsb_query'])
                assert.equal(decideFeatureTool(policy, tool, {}, context).allowed, false);
            count++;
        }
    assert.equal(count, 32);
    for (const change of [c => c.features.conversation.enabled = false, c => c.features.conversation.actions.media.enabled = false,
        c => c.features.conversation.accountIds = [], c => c.accounts.default.allowPrivateGuests = false]) {
        const config = structuredClone(policy); change(config);
        assert.equal(decideFeatureTool(config, 'tts_synthesize', {}, { ...base, senderId: '188888888' }).allowed, false);
    }
    assert.equal(decideFeatureTool(policy, 'tts_synthesize', {}, { ...base, internal: true }).allowed, false);
    assert.equal(decideFeatureTool(policy, 'tts_synthesize', {}, { ...base, scope: 'group', groupId: '999999999' }).allowed, false);
});
test('TTS parameters cannot choose paths or recipients and text is passed as a single argv without shell', () => {
    const text = '今天你也很可爱哦；$(id) `whoami`';
    const params = validateToolParams(BUSINESS_TOOLS.tts_synthesize, { text });
    assert.equal(BUSINESS_TOOLS.tts_synthesize.build(params).argv.at(-1), text);
    for (const params of [{ text: '' }, { text: '测'.repeat(12001) }, { text: '你好', userId: '700000003' }, { text: '你好', output: '/tmp/x.wav' }])
        assert.throws(() => validateToolParams(BUSINESS_TOOLS.tts_synthesize, params));
    assert.equal(BUSINESS_TOOLS.tts_synthesize.approval, false);
});
test('guest speech succeeds once and artifacts are bound to exact sender, account and incoming request', async t => {
    const dir = mkdtempSync(join(tmpdir(), 'onebot-speech-')), store = new OperationStore(join(dir, 'operations.sqlite'));
    t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
    const audio = join(dir, 'voice.wav'); writeFileSync(audio, 'synthetic-speech-artifact');
    let calls = 0;
    const context = { ...base, senderId: '188888888' };
    const input = { name: 'tts_synthesize', params: { text: '今天你也很可爱哦' }, context, sessionKey: 'guest-speech', store, speechReview: async () => ({ allow: true }),
        run: async (_, args, opts) => { calls++; assert.equal(opts.shell, false); assert.equal(args.at(-1), '今天你也很可爱哦'); return { stdout: JSON.stringify({ ok: true, preset: 'elysia-light-v1', audio_output: audio, raw_output: '/private/raw.wav', log: '/private/log' }) }; } };
    const first = await executeBusinessTool({ ...input, callId: 'a' });
    assert.equal(first.details.status, 'succeeded'); assert.doesNotMatch(first.details.output, /\/private\/|raw_output/u);
    const managed = /^audio_output=(.+)$/mu.exec(first.details.output)[1]; t.after(() => rmSync(managed, { force: true }));
    assert.ok(businessMediaAuthorization('guest-speech', managed, context, store));
    for (const change of [{ requestId: 'another' }, { senderId: '700000003' }, { accountId: 'yuexia' }])
        assert.equal(businessMediaAuthorization('guest-speech', managed, { ...context, ...change }, store), null);
    await executeBusinessTool({ ...input, callId: 'b' }); assert.equal(calls, 1);
});
test('automatic speech is bound to registered job, role, feature and destination; revocations take effect', () => {
    const id = '11111111-1111-1111-1111-111111111111';
    const config = structuredClone(policy); config.automationBindings[id] = { enabled: true, feature: 'automation', deliveryGroupIds: ['700000011'] };
    const context = { actorType: 'service', originJobId: id, accountId: 'default', workspaceAgentId: 'synthetic-auto' };
    const registry = { jobs: { [id]: { kind: 'agent', feature: 'automation', accountId: 'default', agentId: 'synthetic-auto', speechTarget: { type: 'group', id: '700000011' } } } };
    assert.equal(resolveSpeechTarget(context, config, registry).target.id, '700000011');
    for (const patch of [{ accountId: 'yuexia' }, { workspaceAgentId: 'other-agent' }, { originJobId: 'unknown' }, { actorType: 'user' }])
        assert.throws(() => resolveSpeechTarget({ ...context, ...patch }, config, registry));
    for (const change of [c => c.automationBindings[id].enabled = false, c => c.features.automation.enabled = false,
        c => c.features.conversation.actions.media.enabled = false, c => c.automationBindings[id].deliveryGroupIds = []]) {
        const revoked = structuredClone(config); change(revoked); assert.throws(() => resolveSpeechTarget(context, revoked, registry));
    }
});
test('event-bound speech delivers once before the model replies and exposes only the platform outcome', async t => {
    const dir = mkdtempSync(join(tmpdir(), 'onebot-speech-send-')), store = new OperationStore(join(dir, 'operations.sqlite'));
    t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
    const audio = join(dir, 'voice.wav'); writeFileSync(audio, 'synthetic-bound-speech');
    const context = { ...base, speechMode: 'explicit', speechDelivery: 'bound-conversation' };
    let generated = 0, delivered = 0, request;
    const input = { name: 'tts_synthesize', params: { text: '大家中午好呀。' }, context, sessionKey: 'bound-speech', store,
        run: async () => { generated++; return { stdout: JSON.stringify({ ok: true, preset: 'elysia-light-v1', audio_output: audio }) }; },
        getDeliveryQueue: () => ({ enqueue: async value => { delivered++; request = value; return { id: 'native-test-receipt', state: 'accepted' }; } }) };
    const first = await executeBusinessTool({ ...input, callId: 'a' });
    assert.equal(first.details.delivered, true); assert.equal(first.details.output, '');
    assert.deepEqual(request.target, { type: 'private', id: '700000003' }); assert.equal(request.parts[0].type, 'record');
    assert.equal(request.dedupeKey, `tts:${first.details.operationId}`);
    t.after(() => rmSync(request.parts[0].path, { force: true }));
    assert.equal(speechDeliveryForTurn(input.sessionKey, context, store).deliveryId, 'native-test-receipt');
    assert.equal(speechDeliveryForTurn(input.sessionKey, context, store).text, input.params.text);
    assert.equal(speechDeliveryForTurn(input.sessionKey, { ...context, requestId: 'another' }, store), null);
    assert.equal(speechDeliveryForTurn(input.sessionKey, { ...context, senderId: '188888888' }, store), null);
    await executeBusinessTool({ ...input, callId: 'b' }); assert.equal(generated, 1); assert.equal(delivered, 1);
    const group = { ...context, scope: 'group', groupId: '700000008' };
    assert.deepEqual(resolveConversationSpeechTarget(group).target, { type: 'group', id: '700000008' });
    for (const change of [{ accountId: 'yuexia' }, { internal: true }, { requestId: '' }, { groupId: '999999999' }])
        assert.throws(() => resolveConversationSpeechTarget({ ...group, ...change }));
});
test('unconfirmed voice delivery returns honest full text fallback and cannot be retried by the model', async t => {
    const dir = mkdtempSync(join(tmpdir(), 'onebot-speech-pending-')), store = new OperationStore(join(dir, 'operations.sqlite'));
    t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
    const audio = join(dir, 'voice.wav'); writeFileSync(audio, 'synthetic-unconfirmed-speech');
    const context = { ...base, speechMode: 'explicit', speechDelivery: 'bound-conversation' }; let sends = 0;
    const input = { name: 'tts_synthesize', params: { text: '大家好呀。' }, context, sessionKey: 'pending-speech', store,
        run: async () => ({ stdout: JSON.stringify({ ok: true, preset: 'elysia-light-v1', audio_output: audio }) }),
        getDeliveryQueue: () => ({ enqueue: async request => { sends++; t.after(() => rmSync(request.parts[0].path, { force: true })); return { id: 'pending-delivery', state: 'native_pending' }; } }) };
    const first = await executeBusinessTool({ ...input, callId: 'a' });
    assert.equal(first.details.delivered, false); assert.equal(first.details.status, 'uncertain'); assert.equal(first.details.output, '');
    assert.match(speechFallbackForTurn(input.sessionKey, context, store).safeReply, /还没能确认送达.*\n大家好呀。/u);
    assert.equal(speechDeliveryForTurn(input.sessionKey, context, store), null);
    await executeBusinessTool({ ...input, callId: 'b' }); assert.equal(sends, 1);
});
test('wrapper stdout failure and private traceback are retained locally while QQ gets an honest full answer', async t => {
    const dir = mkdtempSync(join(tmpdir(), 'onebot-speech-error-')), store = new OperationStore(join(dir, 'operations.sqlite'));
    t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
    mkdirSync(join(dir, 'elysia/task'), { recursive: true });
    const log = join(dir, 'elysia/task/generation.log');
    writeFileSync(log, 'loading model\nTraceback (most recent call last):\n  File "local_deploy/pitch_audio.py", line 86\nRuntimeError: 变调输出时长异常\n');
    const context = { ...base, speechMode: 'explicit', speechDelivery: 'bound-conversation' };
    const input = { name: 'tts_synthesize', params: { text: '大家下午好呀。' }, context, sessionKey: 'failed-speech', store,
        run: async () => { throw Object.assign(new Error('Command failed with private command arguments'), {
            stdout: JSON.stringify({ ok: false, reason: 'generation_failed', log }), code: 1 }); },
        recordSpeechError: (error, id) => recordSpeechFailure(error, id, { root: dir }),
        getDeliveryQueue: () => assert.fail('failed synthesis cannot send') };
    const result = await executeBusinessTool({ ...input, callId: 'one' });
    assert.equal(result.details.status, 'failed'); assert.equal(result.details.error, 'speech_generation_failed');
    assert.equal(result.details.failureStage, 'postprocess_pitch');
    assert.match(speechFallbackForTurn(input.sessionKey, context, store).safeReply, /语音没有生成成功.*\n大家下午好呀。/u);
    assert.doesNotMatch(JSON.stringify(result), /generation\.log|pitch_audio|private command|Traceback/u);
    const diagnostic = JSON.parse(readFileSync(join(dir, 'errors', `${result.details.operationId}.json`), 'utf8'));
    assert.equal(diagnostic.exitCode, 1); assert.match(diagnostic.diagnostic, /变调输出时长异常/u);
    const external = await recordSpeechFailure({ stdout: JSON.stringify({ reason: 'generation_failed', log: '/etc/passwd' }) }, 'a'.repeat(64), { root: dir });
    assert.equal(external.stage, 'execution');
});
test('cancellation propagates to synthesis and prevents publishing an artifact after the task ends', async t => {
    const dir = mkdtempSync(join(tmpdir(), 'onebot-speech-cancel-')), store = new OperationStore(join(dir, 'operations.sqlite'));
    t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
    const controller = new AbortController();
    const result = await executeBusinessTool({ name: 'tts_synthesize', params: { text: '取消测试' }, context: base,
        callId: 'cancel', sessionKey: 'speech-cancel', signal: controller.signal, store,
        run: async (_, __, options) => {
            assert.equal(options.signal, controller.signal); controller.abort();
            return { stdout: JSON.stringify({ ok: true, preset: 'elysia-light-v1', audio_output: '/nonexistent-cancelled.wav' }) };
        } });
    assert.equal(result.details.status, 'failed'); assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM artifacts').get().n, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { planSpeech, speechInstructions, splitSpeechReply, speechLength } from '../src/src/features/speech-policy.js';
import { reviewGuestSpeech } from '../src/src/features/speech-review.js';
import { executeBusinessTool, speechFallbackForTurn } from '../src/src/features/tools.js';
import { OperationStore } from '../src/src/access/operations.js';
import { registerServiceSpeechHooks } from '../src/src/features/speech-hooks.js';
import { bindFeatureTurn, decideFeatureTool } from '../src/src/feature-tools.js';

test('ordinary replies get a 30 percent server decision; explicit, disabled, other-role and peer turns never append', () => {
    let selected = 0;
    for (let i = 0; i < 1000; i++) if (planSpeech({ accountId: 'default' }, { speechMode: 'none' }, { random: () => i / 1000 }).appendix) selected++;
    assert.equal(selected, 300);
    for (const mode of ['answer', 'literal', 'disabled', 'unknown'])
        assert.equal(planSpeech({ accountId: 'default' }, { speechMode: mode }, { random: () => 0 }).appendix, false);
    assert.equal(planSpeech({ accountId: 'yuexia' }, { speechMode: 'none' }, { random: () => 0 }).enabled, false);
    assert.equal(planSpeech({ accountId: 'default', internal: true }, { speechMode: 'none' }, { random: () => 0 }).appendix, false);
});
test('built-in TTS and script shortcuts cannot bypass the dedicated speech rules', () => {
    const policy = JSON.parse(readFileSync('/root/.openclaw/onebot-features.json', 'utf8'));
    const context = { senderId: '700000003', accountId: 'default', scope: 'private' };
    assert.equal(decideFeatureTool(policy, 'tts', {}, context).allowed, false);
    assert.equal(decideFeatureTool(policy, 'exec', { command: 'python3 /root/GPT-SoVITS-local/local_deploy/run_elysia.py --text x' }, context).allowed, false);
    assert.equal(decideFeatureTool(policy, 'tts_synthesize', {}, { ...context, speechMode: 'ordinary' }).allowed, false);
});
test('only model output decides speech mode, never keyword matches in raw user text', () => {
    for (const mode of ['answer', 'literal']) {
        const plan = planSpeech({ accountId: 'default' }, { speechMode: mode }, { random: () => 0 });
        assert.equal(plan.mode, mode); assert.equal(plan.explicit, true); assert.equal(plan.appendix, false);
        assert.match(speechInstructions(plan), /必须调用 tts_synthesize/u);
    }
    for (const input of ['用语音告诉我', '和大家语音打个招呼吧', '不要语音', {}, { speechMode: 'yes' }]) {
        const plan = planSpeech({ accountId: 'default' }, input, { random: () => 0 });
        assert.equal(plan.mode, 'unknown'); assert.equal(plan.explicit, false); assert.equal(plan.appendix, false);
        assert.match(speechInstructions(plan), /分类未完成/u);
    }
    const disabled = planSpeech({ accountId: 'default' }, { speechMode: 'disabled' }, { random: () => 0 });
    assert.equal(disabled.appendix, false); assert.match(speechInstructions(disabled), /拒绝语音/u);
});
test('the main model jointly writes text and <=40 character appendix; unselected, malformed and oversized appendices never send', () => {
    const plan = planSpeech({ accountId: 'default' }, { speechMode: 'none' }, { random: () => 0, token: 'test' });
    assert.match(speechInstructions(plan), /同一条模型回复/);
    const format = text => `正文\n[[VOICE_APPEND:test]]${text}[[/VOICE_APPEND]]`;
    assert.deepEqual(splitSpeechReply(format('好'.repeat(40)), plan), { text: '正文', appendix: '好'.repeat(40) });
    assert.deepEqual(splitSpeechReply(format('好'.repeat(41)), plan), { text: '正文', appendix: '' });
    assert.equal(splitSpeechReply(format('你好'), { ...plan, appendix: false }).appendix, '');
    assert.deepEqual(splitSpeechReply('正文[[VOICE_APPEND:test]]未闭合', plan), { text: '正文', appendix: '' });
    assert.equal(splitSpeechReply(format('你好') + format('再来一句'), plan).appendix, '');
    assert.equal(speechLength('😀'.repeat(40)), 40);
});

function fixture(t) {
    const dir = mkdtempSync(join(tmpdir(), 'speech-policy-')), store = new OperationStore(join(dir, 'operations.sqlite'));
    t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
    const context = { senderId: '700000003', scope: 'private', accountId: 'default', requestId: 'one', speechMode: 'explicit' };
    return { store, context, name: 'tts_synthesize', callId: 'one', sessionKey: 'speech-policy' };
}
test('201 characters return the entire original answer and an explanation before any synthesis; no splitting retry', async t => {
    const input = fixture(t), text = '答'.repeat(201);
    const result = await executeBusinessTool({ ...input, params: { text }, run: () => assert.fail('must not synthesize') });
    assert.equal(result.details.textOnly, true); assert.equal(result.details.fallbackText, text); assert.match(result.details.notice, /超过200字/u);
    assert.equal(speechFallbackForTurn(input.sessionKey, input.context, input.store).fallbackText, text);
    await assert.rejects(executeBusinessTool({ ...input, params: { text: '短句' }, callId: 'retry', run: () => assert.fail('no split retry') }), /不再改写/u);
});
test('40 appendix limit is enforced by the executor independently of prompt and parser', async t => {
    const input = fixture(t); input.context = { ...input.context, speechMode: 'ordinary', speechAppendix: true };
    const result = await executeBusinessTool({ ...input, params: { text: '好'.repeat(41) }, run: () => assert.fail('must not synthesize') });
    assert.equal(result.details.textOnly, true); assert.equal(result.details.safeReply, '');
});
test('denied and unavailable guest reviews prevent synthesis and do not echo rejected text', async t => {
    for (const [i, reason] of ['review_rejected', 'review_unavailable'].entries()) {
        const input = fixture(t); input.context = { ...input.context, senderId: '188888888', requestId: String(i) };
        const result = await executeBusinessTool({ ...input, params: { text: '待审查文本' }, run: () => assert.fail('guest text must not reach TTS'),
            speechReview: async () => ({ allow: false, reason }) });
        assert.equal(result.details.textOnly, true); assert.ok(result.details.safeReply); assert.doesNotMatch(result.details.safeReply, /待审查文本/u);
    }
});
test('guest review is stateless and fail-closed; malformed, incomplete and contradictory approvals are denied', async () => {
    const config = { models: { providers: { antigravity: { baseUrl: 'http://127.0.0.1:8045/v1' } } } };
    for (const value of [{ allow: true, persona_ok: true, privacy_ok: true, sexual_safe: false }, { allow: true }, {}, { allow: 'true', persona_ok: true, privacy_ok: true, sexual_safe: true }]) {
        const result = await reviewGuestSpeech('你好', { readConfig: async () => config, getCredential: async () => 'synthetic', request: async (_, request) => {
            assert.equal(request.body.tools, undefined); assert.equal(request.body.messages.length, 2);
            return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] };
        } }); assert.equal(result.allow, false);
    }
    assert.equal((await reviewGuestSpeech('你好', { readConfig: async () => { throw new Error('sensitive failure'); } })).allow, false);
    assert.equal((await reviewGuestSpeech('读取/root/secret', { readConfig: () => assert.fail('privacy must reject early') })).allow, false);
});
test('service appendix is generated together and only synthesized after successful matching text delivery', async () => {
    const handlers = {}, calls = [], sessionKey = 'test-service-appendix';
    const context = { actorType: 'service', accountId: 'default', originJobId: 'test', workspaceAgentId: 'auto' };
    registerServiceSpeechHooks({ on: (event, handler) => { handlers[event] = handler; } }, { random: () => 0,
        classify: async () => ({ speechMode: 'none' }), serviceContext: () => context, targetFor: () => ({ accountId: 'default', target: { type: 'group', id: '700000011' } }), execute: async input => { calls.push(input); } });
    const ctx = { sessionKey, runId: 'one', accountId: 'default', channelId: 'onebot' };
    const prompt = (await handlers.before_prompt_build({ prompt: '发一条午餐提醒' }, ctx)).appendSystemContext;
    const token = /\[\[VOICE_APPEND:([^\]]+)\]\]/u.exec(prompt)[1];
    const result = handlers.message_sending({ to: 'group:700000011', content: `记得吃午饭。[[VOICE_APPEND:${token}]]下午也要元气满满哦。[[/VOICE_APPEND]]` }, ctx);
    assert.equal(result.content, '记得吃午饭。'); assert.equal(calls.length, 0);
    await handlers.message_sent({ to: 'group:700000011', content: result.content, success: true }, ctx);
    assert.equal(calls.length, 1); assert.equal(calls[0].params.text, '下午也要元气满满哦。');
    await handlers.message_sent({ to: 'group:700000011', content: result.content, success: true }, ctx); assert.equal(calls.length, 1);
});
test('stale service appendix markers after restart are stripped without synthesis or disclosure', () => {
    const handlers = {};
    registerServiceSpeechHooks({ on: (event, handler) => { handlers[event] = handler; } }, { serviceContext: () => null,
        execute: () => assert.fail('stale appendix must not synthesize') });
    const result = handlers.message_sending({ to: 'group:700000011', content: '已完成正文。[[VOICE_APPEND:expired]]内部待追加句[[/VOICE_APPEND]]' }, { channelId: 'onebot', sessionKey: 'unknown' });
    assert.equal(result.content, '已完成正文。');
});
test('core outbound hook preserves only a live inbound appendix until Gateway consumes it', () => {
    const handlers = {}, sessionKey = 'unit:inbound-speech-marker', token = 'one-live-token';
    registerServiceSpeechHooks({ on: (event, handler) => { handlers[event] = handler; } }, { serviceContext: () => null });
    const ctx = { channelId: 'onebot', accountId: 'default', sessionKey };
    const content = `正文[[VOICE_APPEND:${token}]]今天也要开心哦。[[/VOICE_APPEND]]`;
    const release = bindFeatureTurn(sessionKey, { accountId: 'default', scope: 'private', senderId: '700000003', speechToken: token, speechAppendixSelected: true });
    try {
        assert.equal(handlers.message_sending({ to: 'private:700000003', content }, ctx), undefined);
        const wrong = handlers.message_sending({ to: 'private:700000003', content: content.replace(token, 'forged-token') }, ctx);
        assert.equal(wrong.content, '正文');
        const otherAccount = handlers.message_sending({ to: 'private:700000003', content }, { ...ctx, accountId: 'yuexia' });
        assert.equal(otherAccount.content, '正文');
        assert.equal(handlers.message_sending({ to: 'private:188887999', content }, ctx).content, '正文');
    } finally { release(); }
    assert.equal(handlers.message_sending({ to: 'private:700000003', content }, ctx).content, '正文');
});
test('cron destination sessions recover only a live source nonce and an exact registered target', async () => {
    const handlers = {}, calls = [], sourceKey = 'cron-source-nonce-test';
    const context = { actorType: 'service', accountId: 'default', originJobId: 'test', workspaceAgentId: 'auto' };
    registerServiceSpeechHooks({ on: (event, handler) => { handlers[event] = handler; } }, { random: () => 0,
        classify: async () => ({ speechMode: 'none' }), serviceContext: key => key === sourceKey ? context : null,
        targetFor: () => ({ accountId: 'default', target: { type: 'group', id: '700000011' } }),
        execute: async input => { calls.push(input); } });
    const prompt = (await handlers.before_prompt_build({ prompt: '发一条午餐提醒' }, { sessionKey: sourceKey, runId: 'nonce-test' })).appendSystemContext;
    const token = /\[\[VOICE_APPEND:([^\]]+)\]\]/u.exec(prompt)[1];
    const content = `记得吃午饭。[[VOICE_APPEND:${token}]]下午也要元气满满哦。[[/VOICE_APPEND]]`;
    const ctx = { channelId: 'onebot', accountId: 'default', sessionKey: 'destination-group-session' };
    for (const [accountId, to] of [['yuexia', 'group:700000011'], ['default', 'group:700000012']]) {
        const wrong = { ...ctx, accountId };
        const result = handlers.message_sending({ to, content }, wrong);
        assert.equal(result.content, '记得吃午饭。');
        await handlers.message_sent({ to, content: result.content, success: true }, wrong);
    }
    assert.equal(calls.length, 0);
    const result = handlers.message_sending({ to: 'group:700000011', content }, ctx);
    await handlers.message_sent({ to: 'group:700000011', content: result.content, success: true }, ctx);
    assert.equal(calls.length, 1); assert.equal(calls[0].sessionKey, sourceKey);
});

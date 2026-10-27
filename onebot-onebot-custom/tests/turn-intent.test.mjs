import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMessageIntent, parseTurnIntent } from '../src/src/turn-intent.js';
import { resolveGroupQuotaAction, runGroupGuestQuotaAction, GROUP_GUEST_QUOTA_SCRIPT } from '../src/src/group-guest-quota.js';
import { authorizeFeature, loadFeatureConfig } from '../src/src/feature-policy.js';
import { planSpeech } from '../src/src/features/speech-policy.js';
import { registerServiceSpeechHooks } from '../src/src/features/speech-hooks.js';

const response = mode => ({ need_web_search: false, image_generation: false, official_reference: false,
    backend_operation: false, speech_mode: mode, reminder_action: 'none', quota_action: 'none', rationale: 'semantic decision' });
test('one inbound model call returns existing task fields and the semantic speech mode together', async () => {
    let calls = 0;
    const intent = await classifyMessageIntent('别打字，让大家听听你的声音', false, '最近的公开对话', {
        readConfig: async () => ({ models: { providers: { antigravity: { baseUrl: 'https://example.invalid/v1' } } } }),
        getCredential: async () => 'synthetic', request: async (url, { body }) => {
            calls++; assert.equal(url, 'https://example.invalid/v1/chat/completions');
            assert.equal(body.model, 'gemini-3.5-flash-lite'); assert.equal(body.tools, undefined);
            assert.equal(body.messages.length, 2); assert.match(body.messages[0].content, /speech_mode/u);
            assert.match(body.messages[1].content, /最近的公开对话/u);
            return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ...response('answer'), need_web_search: true }) } }] };
        },
    });
    assert.equal(calls, 1); assert.equal(intent.speechMode, 'answer'); assert.equal(intent.needWebSearch, true);
    assert.equal(planSpeech({ accountId: 'default' }, intent).explicit, true);
});
test('speech enums are strict; unavailable and malformed model decisions never fall back to keywords or random voice', async () => {
    for (const content of ['bad-json', JSON.stringify(response('yes')), JSON.stringify({ ...response('answer'), speech_mode: undefined })]) {
        const intent = await classifyMessageIntent('用语音回答', false, '', { complete: async () => content });
        assert.equal(intent.speechMode, 'unknown');
        const plan = planSpeech({ accountId: 'default' }, intent, { random: () => 0 });
        assert.equal(plan.explicit, false); assert.equal(plan.appendix, false);
    }
    const failed = await classifyMessageIntent('不要语音', false, '', { complete: async () => { throw new Error('unavailable'); } });
    assert.equal(failed.speechMode, 'unknown');
    for (const mode of ['none', 'disabled', 'answer', 'literal']) assert.equal(parseTurnIntent(JSON.stringify(response(mode))).speechMode, mode);
    assert.equal(parseTurnIntent(JSON.stringify({ ...response('none'), official_reference: true })).officialReference, false);
    assert.equal(parseTurnIntent(JSON.stringify({ ...response('none'), reminder_action: 'invented' })).reminderAction, 'unknown');
    for (const action of ['create', 'list', 'cancel', 'none']) assert.equal(parseTurnIntent(JSON.stringify({ ...response('none'), reminder_action: action })).reminderAction, action);
});
test('scheduled runs use the same classifier once per run and reuse its result when rebuilding a prompt', async () => {
    const handlers = {}; let calls = 0;
    registerServiceSpeechHooks({ on: (event, fn) => { handlers[event] = fn; } }, {
        serviceContext: () => ({ accountId: 'default' }),
        classify: async text => { calls++; assert.equal(text, '让大家听听你的声音'); return { speechMode: 'answer' }; },
    });
    const ctx = { sessionKey: 'unit:model-classified-cron', runId: 'one' };
    const first = await handlers.before_prompt_build({ prompt: '让大家听听你的声音' }, ctx);
    const second = await handlers.before_prompt_build({ prompt: '让大家听听你的声音' }, ctx);
    assert.equal(calls, 1); assert.deepEqual(first, second); assert.match(first.appendSystemContext, /必须调用 tts_synthesize/u);
});

test('XHS task classification comes from the inbound model and cannot be inferred from keywords',async()=>{
 for (const marked of [true,false,'true',undefined]) {
 const intent=await classifyMessageIntent('在小红书上找高赞coser图片发我',false,'',{complete:async()=>JSON.stringify({...response('none'),xiaohongshu_operation:marked})});
 assert.equal(intent.xiaohongshuOperation,marked===true);
 }
});


test('quota uses the same inbound completion for the original failed message, then only fixed argv after authorization', async () => {
    let classifications = 0, executions = 0;
    const intent = await classifyMessageIntent('刷新agy额度并检查还剩多少', false, '', {
        complete: async prompt => {
            classifications++;
            const data = JSON.parse(prompt.split('不可信的消息数据：\n')[1]);
            assert.equal(data.message, '刷新agy额度并检查还剩多少');
            assert.match(prompt, /quota_action/u);
            return JSON.stringify({ ...response('none'), backend_operation: true, quota_action: 'refresh' });
        },
    });
    const policy = loadFeatureConfig();
    for (const senderId of ['700000003', '188888888']) {
        const context = { senderId, accountId: 'default', scope: 'group', groupId: '700000008', explicit: true, roleCount: 1 };
        const action = resolveGroupQuotaAction({ isGroup: true, peerFollowup: false, explicit: context.explicit, roleCount: context.roleCount, intent });
        assert.equal(action, 'refresh');
        assert.equal(authorizeFeature(policy, 'quota', 'refresh', context).allowed, true);
        await runGroupGuestQuotaAction(action, async (file, args, options) => {
            executions++;
            assert.equal(file, GROUP_GUEST_QUOTA_SCRIPT);
            assert.deepEqual(args, ['refresh']);
            assert.equal(options.shell, undefined);
            return { stdout: 'refresh_http=200\nrefresh_total=0\nrefresh_success=0\nrefresh_failed=0\naccount_count=0' };
        });
        assert.equal(authorizeFeature(policy, 'quota', 'refresh', { ...context, groupId: '700000012' }).allowed, false);
    }
    assert.equal(classifications, 1); assert.equal(executions, 2);
});

test('quota classification is strict and never falls back to a command or a keyword on model failure', async () => {
    for (const quota_action of ['none', 'query', 'refresh'])
        assert.equal(parseTurnIntent(JSON.stringify({ ...response('none'), quota_action })).quotaAction, quota_action);
    for (const quota_action of [undefined, null, 'quota', true, 'refresh; id'])
        assert.equal(parseTurnIntent(JSON.stringify({ ...response('none'), quota_action })).quotaAction, 'unknown');
    for (const complete of [async () => 'not json', async () => JSON.stringify({ ...response('none'), quota_action: 'invalid' }),
        async () => { throw new Error('unavailable'); }]) {
        const intent = await classifyMessageIntent('/agy refresh 刷新agy额度', false, '', { complete });
        assert.equal(intent.quotaAction, 'unknown');
        assert.equal(resolveGroupQuotaAction({ isGroup: true, explicit: true, roleCount: 1, intent }), null);
    }
    let calls = 0;
    const intent = await classifyMessageIntent('/agy refresh', false, '', { complete: async () => {
        calls++; return JSON.stringify({ ...response('none'), quota_action: 'none' });
    } });
    assert.equal(calls, 1); assert.equal(intent.quotaAction, 'none');
    assert.equal(resolveGroupQuotaAction({ isGroup: true, explicit: true, roleCount: 1, intent }), null);
});

const fallbackConfig = { models: { providers: {
    antigravity: { baseUrl: 'https://primary.invalid/v1' },
    novacode: { baseUrl: 'https://fallback.invalid/v1' },
    grok: { baseUrl: 'https://last.invalid/v1' },
} } };
const fallbackRouting = () => ({ errorFallbacks: [{ model: 'novacode/qwen3.8-flash-next' }, { model: 'grok/grok-4.7' }] });
const classified = action => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ...response('none'), quota_action: action, backend_operation: true }) } }] });
test('quota classification falls back to another LLM after the primary quota pool returns 503', async () => {
    const calls = [], warnings=[];
    const result = await classifyMessageIntent('检查一下agy的每周额度还剩多少', false, '', {
        readConfig: async()=>fallbackConfig, readRouting:fallbackRouting, getCredential:async()=> 'synthetic',
        log:{warn:m=>warnings.push(m)},
        request:async(_url,options)=>{
            calls.push(options.body.model);assert.equal(options.body.tools,undefined);
            if(calls.length===1)throw Object.assign(Error('HTTP 503: secret provider body'),{code:'HTTP 503'});
            return classified('query');
        },
    });
    assert.deepEqual(calls,['gemini-3.5-flash-lite','qwen3.8-flash-next']);
    assert.equal(result.quotaAction,'query');
    assert.equal(resolveGroupQuotaAction({isGroup:true,peerFollowup:false,explicit:true,roleCount:1,intent:result}),'quota');
    assert.match(warnings.join('\n'),/http-503/u);assert.doesNotMatch(warnings.join('\n'),/secret provider body/u);
});
test('malformed fallback is skipped and a valid final LLM decision is honored', async()=>{
    let calls=0;
    const result=await classifyMessageIntent('刷新agy额度',false,'',{
        readConfig:async()=>fallbackConfig,readRouting:fallbackRouting,getCredential:async()=> 'synthetic',
        request:async()=>{calls++;if(calls===1)throw Error('unavailable');if(calls===2)return {choices:[{finish_reason:'stop',message:{content:'not json'}}]};return classified('refresh');},
    });
    assert.equal(calls,3);assert.equal(result.quotaAction,'refresh');
});
test('negative LLM classification does not invoke another model or infer quota from keywords',async()=>{
    let calls=0;
    const result=await classifyMessageIntent('/agy refresh 查询刷新额度',false,'',{
        readConfig:async()=>fallbackConfig,readRouting:fallbackRouting,getCredential:async()=> 'synthetic',
        request:async()=>{calls++;return classified('none');},
    });
    assert.equal(calls,1);assert.equal(result.quotaAction,'none');
});
test('all classifier models failing or cancellation keeps quota unknown and runs no script',async()=>{
    let calls=0;
    const options={readConfig:async()=>fallbackConfig,readRouting:fallbackRouting,getCredential:async()=> 'synthetic',
        request:async()=>{calls++;throw Error('private secret');}};
    const result=await classifyMessageIntent('刷新agy额度',false,'',options);
    assert.equal(calls,3);assert.equal(result.quotaAction,'unknown');
    const controller=new AbortController();controller.abort();calls=0;
    assert.equal((await classifyMessageIntent('刷新agy额度',false,'',{...options,signal:controller.signal})).quotaAction,'unknown');
    assert.equal(calls,0);
});

test('classifier fallback respects each provider reasoning compatibility',async()=>{
    const config=structuredClone(fallbackConfig);
    config.models.providers.novacode.models=[{id:'qwen3.8-flash-next',compat:{supportsReasoningEffort:false}}];
    config.models.providers.grok.models=[{id:'grok-4.7',compat:{supportsReasoningEffort:true,supportedReasoningEfforts:['low','medium','high']}}];
    const calls=[];
    const result=await classifyMessageIntent('检查一下agy的每周额度还剩多少',false,'',{
        readConfig:async()=>config,readRouting:fallbackRouting,getCredential:async()=> 'synthetic',
        request:async(_url,{body})=>{calls.push(body.model);if(body.model==='gemini-3.5-flash-lite')throw Error('503');
            if(body.model==='qwen3.8-flash-next'){assert.equal(body.reasoning_effort,undefined);throw Error('unavailable');}
            assert.equal(body.reasoning_effort,'low');return classified('query');},
    });
    assert.equal(calls.length,3);assert.equal(result.quotaAction,'query');
});

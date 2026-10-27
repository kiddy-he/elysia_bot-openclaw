import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { flashLiteRoutes,withFlashLiteFallback,OFFICIAL_FLASH_LITE,callConfiguredChat,requestOfficialGeminiJson } from '../src/src/flash-lite-fallback.js';
import { nativeChatBody,validateAssessment } from '../scripts/flash-lite-request.mjs';
import { reviewGuestSpeech } from '../src/src/features/speech-review.js';
const primary={model:'antigravity/gemini-3.5-flash-lite',thinking:'off'};
const routing={flashLiteFallbacks:[{model:OFFICIAL_FLASH_LITE,thinking:'off'},{model:'novacode/qwen3.8-flash-next',thinking:'off'},{model:'grok/grok-4.7',thinking:'low'}]};
const config={models:{providers:Object.fromEntries(['antigravity','gemini-official','novacode','grok'].map(id=>[id,{baseUrl:'https://'+id+'.invalid/v1',models:[{id:'gemini-3.5-flash-lite',compat:{supportsReasoningEffort:false}}]}]))}};
test('AGY unavailable selects official before Qwen; all earlier failures select Qwen',async()=>{
    for(const failures of [1,2]){
        const calls=[];const result=await withFlashLiteFallback(primary,async route=>{calls.push(route.model);if(calls.length<=failures)throw Error('HTTP 503');return route.model;},{routing});
        assert.deepEqual(calls,[primary.model,...routing.flashLiteFallbacks.map(r=>r.model)].slice(0,failures+1));assert.equal(result,calls.at(-1));
    }
    assert.deepEqual(flashLiteRoutes({model:'antigravity/gemini-3.8-flash-high'},routing),[{model:'antigravity/gemini-3.8-flash-high'}]);
});
test('valid negative decision is final; exhausted/cancelled chains throw',async()=>{
    let calls=0;assert.deepEqual(await withFlashLiteFallback(primary,async()=>{calls++;return {allow:false};},{routing}),{allow:false});assert.equal(calls,1);
    await assert.rejects(withFlashLiteFallback(primary,async()=>{throw Error('unavailable');},{routing}));
    const c=new AbortController();c.abort();await assert.rejects(withFlashLiteFallback(primary,()=>assert.fail('must not invoke'),{routing,signal:c.signal}));
});
test('official requests use shared proxy transport and omit unsupported reasoning',async()=>{
    let seen=false;
    const response=await callConfiguredChat(routing.flashLiteFallbacks[0],{messages:[],reasoning_effort:'off'}, {config,getCredential:async()=> 'synthetic',officialRequest:async(url,o)=>{seen=true;assert.match(url,/gemini-official/u);assert.equal(o.body.reasoning_effort,undefined);assert.equal(o.apiKey,'synthetic');return {ok:true};}});
    assert.equal(seen,true);assert.equal(response.ok,true);
});
test('official transport supplies proxy, stdin JSON, bounded timeout and sanitized errors',async()=>{
    let input='';const execute=(program,args,options,cb)=>{
        assert.equal(program,'/bin/sh');assert.match(args[1],/--proxy/u);assert.doesNotMatch(args.join(' '),/synthetic-key/u);
        assert.equal(options.env.ONEBOT_OFFICIAL_PROXY,'http://127.0.0.1:7890');assert.equal(options.env.ONEBOT_OFFICIAL_KEY,'synthetic-key');
        const stdin=new Writable({write(chunk,_encoding,next){input+=chunk.toString();next();}});stdin.on('finish',()=>cb(null,'{"ok":true}\n200'));return {stdin};
    };
    assert.deepEqual(await requestOfficialGeminiJson('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',{apiKey:'synthetic-key',body:{test:1},timeoutMs:1000,execute}),{ok:true});assert.equal(input,'{"test":1}');
    assert.throws(()=>requestOfficialGeminiJson('https://other.invalid',{body:{}}),/host/u);
    await assert.rejects(requestOfficialGeminiJson('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',{apiKey:'synthetic-key',body:{},timeoutMs:1000,execute:(_p,_a,_o,cb)=>{queueMicrotask(()=>cb(null,'private provider error\n503'));return {stdin:new Writable({write(_c,_e,n){n();}})};}}),/^Error: HTTP 503: official Gemini request failed$/u);
});
test('native bridge preserves text, ordered image data and system instruction',()=>{
    const body=nativeChatBody({systemInstruction:{parts:[{text:'system'}]},contents:[{role:'user',parts:[{text:'candidate'},{inline_data:{mime_type:'image/png',data:'AAA'}},{inlineData:{mimeType:'image/jpeg',data:'BBB'}}]}]});
    assert.equal(body.messages[0].content,'system');assert.deepEqual(body.messages[1].content.map(p=>p.type),['text','image_url','image_url']);assert.equal(body.messages[1].content[2].image_url.url,'data:image/jpeg;base64,BBB');
});
test('bridge validates evidence schema without rejecting valid negative judgments',()=>{
    const negative={lighting_matches:false,activity_matches:true,caption_matches:true,no_temporal_conflict:false,observed_lighting:'夜晚',observed_activity:'读书',failures:['白天计划使用夜景']};
    assert.doesNotThrow(()=>validateAssessment(negative,'qzone-time'));
    assert.throws(()=>validateAssessment({allow:true},'qzone-time'),/evidence/u);
    assert.throws(()=>validateAssessment([],undefined));
});
test('speech review falls back on malformed result and honors official rejection',async()=>{
    const calls=[];const result=await reviewGuestSpeech('今天你好',{readConfig:async()=>config,readRouting:()=>routing,getCredential:async()=> 'synthetic',request:async(url)=>{
        calls.push(url);return {choices:[{finish_reason:'stop',message:{content:JSON.stringify(calls.length===1?{}:{allow:false,persona_ok:false,privacy_ok:true,sexual_safe:true})}}]};
    }});
    assert.equal(calls.length,2);assert.match(calls[1],/gemini-official/u);assert.equal(result.allow,false);assert.equal(result.model,OFFICIAL_FLASH_LITE);
});

test('media reviewer retries malformed decisions, then preserves a valid rejection',async()=>{
    const {prepareMediaReply}=await import('../src/src/media-reply.js');const calls=[];
    const result=await prepareMediaReply({feature:'xhs',posts:[],agentId:'test',generationRoute:{model:'novacode/generation',thinking:'off'},reviewRoute:primary,
        readRouting:()=>routing,readConfig:async()=>config,readPersona:async()=>'',getCredential:async()=> 'synthetic',request:async(url,{body})=>{
            calls.push({url,model:body.model});let value=body.model==='generation'?{text:'这些分享可以慢慢看看哦。',appendix:''}:url.includes('antigravity')?{allow:'true'}:{allow:false};
            return {choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]};
        }});
    assert.equal(result,null);assert.equal(calls.length,3);assert.match(calls[2].url,/gemini-official/u);
});

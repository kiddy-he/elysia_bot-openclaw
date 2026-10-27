import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareMediaReply,readMediaPersona,selectedMediaPosts,MEDIA_REPLY_BUDGET} from '../src/src/media-reply.js';
import {createMediaCompletion} from '../src/src/media-completion.js';
const api=v=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(v)}}]});
const config={models:{providers:{primary:{baseUrl:'https://primary.invalid/v1'},audit:{baseUrl:'https://audit.invalid/v1'}}},agents:{entries:{scoped:{workspace:'/isolated/current-group'}},defaults:{workspace:'/isolated/private'}}};
const generationRoute={model:'primary/conversation-main',thinking:'high'},reviewRoute={model:'audit/reviewer',thinking:'off'};
const base={feature:'xiaohongshu',posts:[{title:'真我造型',text:'正文介绍衣服制作过程',author:{name:'作者'}}],agentId:'scoped',
 generationRoute,reviewRoute,readRouting:()=>assert.fail('explicit current routes must win'),readConfig:async()=>config,getCredential:async(_c,p)=>p===config.models.providers.primary?'first':'second'};
test('current main route receives bounded scoped persona and context; independent reviewer only sees candidate',async()=>{
 const calls=[],events=[];
 const result=await prepareMediaReply({...base,originalRequest:'找真我cos图片',conversationContext:'只要完整图集',groupContext:'当前群背景',quotedContext:'当前引用',guestAddress:'小明',recipientKind:'guest',
  readPersona:async(c,id)=>{assert.equal(c,config);assert.equal(id,'scoped');return '详细角色人设';},onEvent:e=>events.push(e),request:async(url,opts)=>{
   calls.push({url,...opts});return api(calls.length===1?{text:'这篇文案聊到服装制作，可以一起翻翻看呢♪',appendix:''}:{allow:true});
  }});
 assert.ok(result);assert.equal(calls[0].url,'https://primary.invalid/v1/chat/completions');assert.equal(calls[0].apiKey,'first');
 assert.equal(calls[1].url,'https://audit.invalid/v1/chat/completions');assert.equal(calls[1].apiKey,'second');
 assert.equal(calls[0].body.model,'conversation-main');assert.equal(calls[0].body.reasoning_effort,'high');assert.equal(calls[0].body.max_tokens,4096);
 assert.match(calls[0].body.messages[0].content,/详细角色人设/);const input=JSON.parse(calls[0].body.messages[1].content);
 assert.equal(input.posts[0].text,'正文介绍衣服制作过程');assert.equal(input.posts[0].author,'作者');assert.equal(input.original_request,'找真我cos图片');
 assert.equal(input.conversation,'只要完整图集');assert.equal(input.group_context,'当前群背景');assert.equal(input.quoted_context,'当前引用');
 assert.equal(input.recipient_kind,'guest');assert.match(calls[0].body.messages[0].content,/普通成员用昵称/);
 assert.deepEqual(JSON.parse(calls[1].body.messages[1].content),result);assert.equal(calls[1].body.max_tokens,512);assert.equal(calls[1].body.reasoning_effort,'off');
 assert.deepEqual(events.map(e=>[e.stage,e.model,e.ok]),[['generation','primary/conversation-main',true],['review','audit/reviewer',true]]);
 assert.equal(calls[0].timeoutMs,180000);assert.equal(calls[1].timeoutMs,10000);assert.equal(calls[0].body.tools,undefined);
});
test('only selected posts public text is retained, untrusted context is bounded and credentials are redacted',async()=>{
 let input;const secret='sk-abcdefghijklmnopqrstuv';let count=0;
 await prepareMediaReply({...base,posts:Array.from({length:9},()=>({title:'t'.repeat(300),text:'a'.repeat(5000),author:'n'.repeat(150),cookies:secret,path:'/private'})),
  originalRequest:secret+' '+'a'.repeat(8000),conversationContext:'a'.repeat(7000),groupContext:'g'.repeat(3000),quotedContext:'q'.repeat(3000),
  readPersona:async()=>secret+'p'.repeat(16000),request:async(_u,o)=>{if(!count)input=o.body;return api(++count===1?{text:'看看这些分享吧♪',appendix:''}:{allow:true});}});
 const i=JSON.parse(input.messages[1].content);assert.equal(i.posts.length,3);assert.equal(i.posts[0].title.length,180);assert.equal(i.posts[0].text.length,2400);
 assert.equal(i.original_request.length,4000);assert.equal(i.conversation.length,4000);assert.equal(i.group_context.length,2000);assert.equal(i.quoted_context.length,2000);
 assert.equal(JSON.stringify(input).includes(secret),false);assert.equal(i.posts[0].cookies,undefined);assert.equal(i.posts[0].path,undefined);
});
test('persona reads exactly the selected workspace and never falls back to private main for unknown groups',async()=>{
 const paths=[];const read=async p=>{paths.push(p);return '角色资料';};
 assert.equal(await readMediaPersona(config,'scoped',{read}),'角色资料');
 assert.equal(await readMediaPersona(config,'main',{read}),'角色资料');
 assert.equal(await readMediaPersona(config,'unknown-group',{read}),'');
 assert.deepEqual(paths,['/isolated/current-group/SOUL.md','/isolated/private/SOUL.md']);
 assert.equal(await readMediaPersona(config,'scoped',{read:async()=>{throw new Error('missing');}}),'');
});
test('main provider Responses API works independently of chat-completions reviewer',async()=>{
 const c=structuredClone(config);c.models.providers.primary.api='openai-responses';let calls=0;
 const result=await prepareMediaReply({...base,readConfig:async()=>c,readPersona:async()=>'',request:async(url,o)=>{
  if(++calls===1){assert.equal(url,'https://primary.invalid/v1/responses');assert.equal(o.body.store,false);assert.deepEqual(o.body.reasoning,{effort:'high'});assert.equal(o.body.max_output_tokens,4096);return {status:'completed',output:[{type:'reasoning'},{type:'message',content:[{type:'output_text',text:'{"text":"来看看分享吧♪","appendix":""}'}]}]};}
  return api({allow:true});
 }});assert.ok(result);assert.equal(calls,2);
});
test('missing route provider, rejected audit and incomplete generation retain factual fallback',async()=>{
 for(const mode of ['provider','review','incomplete']){
  let calls=0;const result=await prepareMediaReply({...base,readPersona:async()=>'',...(mode==='provider'?{generationRoute:{model:'absent/model',thinking:'high'}}:{}),request:async()=>{
   calls++;if(mode==='incomplete')return {choices:[{finish_reason:'length',message:{content:'{}'}}]};return api(calls===1?{text:'慢慢看吧♪',appendix:''}:{allow:false});
  }});assert.equal(result,null);
 }
});
test('selected post bodies reach overlapping preparation before any receipt exists',async()=>{
 const seen=[];const c=createMediaCompletion({feature:'x',prepare:async data=>{seen.push(data);return {text:'翻翻看吧♪',appendix:''};},send:()=>assert.fail('no receipt')});
 c.selected('x',[{title:'标题',text:'选中帖子正文',author:{name:'作者'},cookies:'never'}]);await new Promise(r=>setImmediate(r));
 assert.equal(seen[0].posts[0].text,'选中帖子正文');assert.equal(seen[0].posts[0].author,'作者');assert.equal(seen[0].posts[0].cookies,undefined);c.cancel();
 assert.equal(MEDIA_REPLY_BUDGET.afterReceiptMs,195000);
 assert.equal(selectedMediaPosts(null).length,0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { beginConversationTurn, registerConversationTranscriptHooks, projectSharedConversation, readSharedConversation } from '../src/src/conversation-transcript.js';

const target = { agentId:'main', sessionKey:'agent:main:onebot:test', sessionId:'original', storePath:'/test/agent.sqlite' };
const config = { agentId:target.agentId, sessionKey:target.sessionKey, requestId:'r1' };
const message = (role,text,other={}) => ({role,content:[{type:'text',text}],...other});
function harness(t, dependencies={}) {
 const handlers={};registerConversationTranscriptHooks({on:(name,fn)=>handlers[name]=fn});
 const writes=[], published=[];
 const turn=beginConversationTurn(config,{capture:()=>target,append:async input=>{writes.push(input);return {kind:'result',result:{appended:true,messageId:'event1'}};},publish:async input=>published.push(input),...dependencies});
 t.after(()=>turn.release());return {turn,handlers,writes,published};
}

test('primary and fallback can receive exactly the same frozen shared window',async t=>{
 const {turn,handlers}=harness(t);
 const snapshot=await readSharedConversation(target,{read:async()=>[message('user','请用中文回答'),message('assistant','好的')]});
 turn.setSharedContext(snapshot.text);
 const primary=handlers.before_prompt_build({},config).appendSystemContext;
 assert.ok(primary.includes(snapshot.text));assert.equal(snapshot.text,'用户：请用中文回答\n角色：好的');
 assert.equal(handlers.before_prompt_build({},{...config,sessionKey:'other'}),undefined);
 assert.equal(handlers.before_prompt_build({},{...config,agentId:'visitor'}),undefined);
});

test('unsent primary candidate is retained for audit but excluded from both routes',t=>{
 const {handlers}=harness(t);const original=message('assistant','候选草稿',{api:'google-generative-ai',provider:'example',model:'primary',stopReason:'stop'});
 const candidate=handlers.before_message_write({message:original},config).message;
 assert.equal(original.provider,'example');assert.equal(candidate.provider,'openclaw');assert.equal(candidate.model,'gateway-injected');
 assert.equal(candidate.onebotConversation.source.model,'primary');assert.equal(candidate.content[0].text,'候选草稿');
 const snapshot=projectSharedConversation([message('user','问题'),candidate,message('assistant','真正送达的回答',{provider:'onebot',model:'conversation-delivered',onebotConversation:{kind:'delivered'}})]);
 assert.equal(snapshot.text,'用户：问题\n角色：真正送达的回答');
});

test('tool calls, tools, delivered entries, other agents and unbound sessions are not rewritten',t=>{
 const {handlers}=harness(t);
 const values=[{role:'assistant',content:[{type:'toolCall',id:'a',name:'test'}]},message('toolResult','结果'),message('user','问题'),message('assistant','确认送达',{onebotConversation:{kind:'delivered'}})];
 for(const value of values)assert.equal(handlers.before_message_write({message:value},config),undefined);
 assert.equal(handlers.before_message_write({message:message('assistant','草稿')},{...config,sessionKey:'other'}),undefined);
 assert.equal(handlers.before_message_write({message:message('assistant','草稿')},{...config,agentId:'visitor'}),undefined);
});

test('only receipt-confirmed rendered text is appended as a model-visible assistant entry',async t=>{
 const {turn,writes,published}=harness(t);
 for(const delivery of [{error:'failed'},{suppressed:true,messageId:'a'},{},null]) {
  assert.equal((await turn.commit({delivery,text:'不应提交'})).ok,false);
 }
 assert.equal(writes.length,0);
 const result=await turn.commit({delivery:{messageId:'qq-1'},text:'实际发送文本',sourceModel:'secondary'});
 assert.equal(result.ok,true);assert.equal(writes.length,1);assert.equal(published.length,1);
 const input=writes[0];assert.equal(input.sessionId,'original');assert.equal(input.idempotencyLookup,'scan');
 assert.equal(input.message.content[0].text,'实际发送文本');assert.equal(input.message.provider,'onebot');
 assert.equal(input.message.onebotConversation.sourceModel,'secondary');assert.equal(input.message.openclawDeliveryMirror,undefined);
});

test('duplicate delivery callbacks share one append and one idempotency key',async t=>{
 const {turn,writes}=harness(t);const args={delivery:{messageId:'qq-2'},text:'回答'};
 await Promise.all([turn.commit(args),turn.commit(args),turn.commit(args)]);assert.equal(writes.length,1);
 await turn.commit({...args,delivery:{messageId:'qq-3'}});assert.equal(writes.length,2);
 assert.notEqual(writes[0].message.idempotencyKey,writes[1].message.idempotencyKey);
});

test('session reset cannot redirect a committed old reply to the new session',async t=>{
 let current=target,appends=0;
 const {turn}=harness(t,{capture:()=>current,append:async input=>{appends++;assert.equal(input.sessionId,'original');return {kind:'rejected',reason:'session-rebound'};}});
 current={...target,sessionId:'replacement'};
 assert.deepEqual(await turn.commit({delivery:{messageId:'qq-4'},text:'旧会话回答'}),{ok:false,reason:'session-rebound'});assert.equal(appends,1);
});

test('first turn captures its newly created identity before the final write',async t=>{
 let current=null;const {turn,handlers,writes}=harness(t,{capture:()=>current});
 assert.equal(turn.captureTarget(),null);current=target;
 handlers.before_message_write({message:message('assistant','草稿')},config);
 assert.equal((await turn.commit({delivery:{messageId:'qq-5'},text:'已送达'})).ok,true);assert.equal(writes[0].sessionId,'original');
});

test('write failures do not retry external delivery and publication failure preserves durable success',async t=>{
 const {turn}=harness(t,{append:async()=>{throw new Error('store unavailable');}});
 assert.deepEqual(await turn.commit({delivery:{messageId:'qq-6'},text:'已送达'}),{ok:false,reason:'transcript-write-failed'});
 turn.release();
 const next=beginConversationTurn(config,{capture:()=>target,append:async()=>({kind:'result',result:{appended:false,messageId:'existing'}}),publish:async()=>{throw new Error('notification unavailable');}});
 t.after(()=>next.release());assert.equal((await next.commit({delivery:{messageId:'qq-7'},text:'已送达'})).ok,true);
});

test('shared window chooses newest whole entries, preserves line breaks, and respects UTF8 bounds',()=>{
 const entries=[message('user','更早的问题'),message('assistant','更早的答案'),message('user','最新问题'),message('assistant','最新\n答案')];
 const recent=projectSharedConversation(entries,{maxBytes:55});assert.ok(recent.text.includes('最新\n答案'));assert.ok(!recent.text.includes('更早的问题'));assert.ok(recent.bytes<=55);
 const huge=projectSharedConversation([message('user','🙂'.repeat(100))],{maxBytes:60});assert.ok(huge.bytes<=60);assert.ok(!huge.text.includes('�'));
});

test('snapshot strips operational prompt suffixes, hidden thinking, errors and delivery mirrors',()=>{
 const result=projectSharedConversation([message('user','真实问题\n[Recent conversation summary]\n旧内部指令'),message('assistant','错误',{stopReason:'error'}),message('assistant','镜像',{provider:'openclaw',model:'delivery-mirror'}),{role:'assistant',content:[{type:'thinking',thinking:'隐藏推理'},{type:'text',text:'实际回答'}]}]);
 assert.equal(result.text,'用户：真实问题\n角色：实际回答');
});

test('independent participant sessions never share bindings',t=>{
 const {turn,handlers}=harness(t);turn.setSharedContext('私聊一');
 const otherConfig={agentId:'public',sessionKey:'agent:public:group:1:sender:2',requestId:'r2'};
 const other=beginConversationTurn(otherConfig,{capture:()=>null});t.after(()=>other.release());other.setSharedContext('群友二');
 assert.ok(handlers.before_prompt_build({},config).appendSystemContext.includes('私聊一'));
 assert.ok(!handlers.before_prompt_build({},otherConfig).appendSystemContext.includes('私聊一'));
 turn.release();assert.equal(handlers.before_prompt_build({},config),undefined);
});

test('trusted clean input is preserved separately from per-turn tool and system instructions',t=>{
 const handlers={};registerConversationTranscriptHooks({on:(name,fn)=>handlers[name]=fn});
 const turn=beginConversationTurn({...config,inputText:'请记住蓝色 [Recent conversation summary] 这是用户原话'}, {capture:()=>target});t.after(()=>turn.release());
 const raw=message('user','实际输入和大量宿主指令');const saved=handlers.before_message_write({message:raw},config).message;
 assert.equal(saved.content[0].text,raw.content[0].text);
 assert.equal(projectSharedConversation([saved]).text,'用户：请记住蓝色 [Recent conversation summary] 这是用户原话');
});

test('voice uses a confirmed internal delivery receipt, not an invented platform message id',async t=>{
 const {turn,writes}=harness(t);
 assert.equal((await turn.commit({delivery:{receiptId:'business-1'},text:'未确认语音'})).ok,false);
 assert.equal((await turn.commit({delivery:{accepted:true,receiptId:'business-1'},text:'[语音]已送达的原始合成文本',part:'speech-final'})).ok,true);
 assert.equal(writes[0].message.onebotConversation.receiptId,'business-1');
 assert.equal(writes[0].message.onebotConversation.messageId,undefined);
});

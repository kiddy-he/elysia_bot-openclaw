import './helpers/legacy-xhs-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {XhsSmsRecovery,actual461} from '../src/src/features/xhs-sms-recovery.js';
import {prepareXhsResume} from '../src/src/features/xhs-resume.js';
import {XhsService} from '../src/src/xhs/service.js';
import {OperationStore} from '../src/src/access/operations.js';
import {decideFeatureTool} from '../src/src/feature-tools.js';
import {executeBusinessTool} from '../src/src/features/tools.js';
import {executeXhsOperation,observeXhsAuthResult} from '../src/src/features/xhs.js';
import {loadFeatureConfig} from '../src/src/feature-policy.js';
const admin='700000003';
const c={accountId:'default',scope:'group',groupId:'700000012',senderId:'188888888',requestId:'request-a',explicit:true,roleCount:1,xiaohongshuOperation:true};
const failure={operation:'search',ok:false,error:{code:'challenge_required',status:461}};
async function fixture(t) {
 const dir=await mkdtemp(join(tmpdir(),'xhs-sms-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 let time=Date.now(),sequence=100,allowed=true,loginError;
 const messages=[],calls=[],resumed=[];
 const options={file:join(dir,'state.json'),phoneFile:join(dir,'phone.json'),now:()=>time,admins:()=>[admin],
  send:async(id,text)=>{messages.push({id,text,messageId:String(++sequence)});return {messageId:String(sequence)};},
  login:async(op,value)=>{calls.push({op,value});if(loginError)throw loginError;return op==='send'?{status:'sms_requested',pending_expires_at:new Date(time+600000).toISOString()}:{authenticated:true};},
  authorize:async()=>allowed,resume:()=>async task=>resumed.push(task.key)};
 const recovery=new XhsSmsRecovery(options);
 const reply=(id,value,extra={})=>({message_type:'private',user_id:admin,message_id:++sequence,message:[{type:'reply',data:{id}},{type:'text',data:{text:value}}],...extra});
 const remember=(context=c)=>recovery.remember(context,{messages:[{text:'找一些爱莉西雅图片'}]});
 async function trigger(){remember();await recovery.observe(failure,c);const other={...c,requestId:'request-b'};remember(other);await recovery.observe(failure,other);await recovery.flight;return other;}
 return {dir,recovery,options,messages,calls,resumed,reply,remember,trigger,advance:ms=>{time+=ms;},revoke:()=>{allowed=false;},error:e=>{loginError=e;}};
}
test('continuous 461 means distinct upstream failures; local terminal repeats do not send SMS',async t=>{
 const f=await fixture(t);f.remember();
 assert.equal((await f.recovery.observe(failure,c)).status,'watching');
 for(let i=0;i<3;i++)await f.recovery.observe({...failure,error:{...failure.error,stopped_in_request:true}},c);
 assert.equal(f.messages.length,0);assert.equal(f.calls.length,0);
 assert.equal(actual461({...failure,error:{code:'challenge_required',upstream_code:-13002}}),false);
 const other={...c,requestId:'request-b'};f.remember(other);await f.recovery.observe(failure,other);await f.recovery.flight;
 assert.equal(f.messages.length,1);assert.equal(f.recovery.state.flow.status,'need_phone');
 await f.recovery.observe(failure,other);assert.equal(f.messages.length,1);
});
test('private quoted phone then OTP logs in once and resumes original tasks only after original turns finish',async t=>{
 const f=await fixture(t),other=await f.trigger();
 const phonePrompt=f.messages.at(-1).messageId;
 assert.equal(await f.recovery.handle(f.reply(phonePrompt,'13900000000'),'default'),true);
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].op,'send');
 const codePrompt=f.messages.at(-1).messageId;
 assert.equal(await f.recovery.handle(f.reply(codePrompt,'012345'),'default'),true);
 assert.equal(f.calls.at(-1).value,'012345');assert.equal(f.recovery.state.flow.status,'authenticated');
 const state=await readFile(f.options.file,'utf8');assert.equal(state.includes('012345'),false);assert.equal(state.includes('13900000000'),false);
 assert.equal((await stat(f.options.phoneFile)).mode & 0o777,0o600);
 await f.recovery.tick();assert.equal(f.resumed.length,0);
 f.recovery.finish(c);f.recovery.finish(other);await f.recovery.tick();assert.equal(f.resumed.length,2);
 await f.recovery.handle(f.reply(codePrompt,'012345'),'default');await f.recovery.tick();assert.equal(f.calls.length,2);assert.equal(f.resumed.length,2);
});
test('auth binding enforces private actual admin, original bot, quote and six-digit string',async t=>{
 const f=await fixture(t);await f.trigger();await f.recovery.handle(f.reply(f.messages.at(-1).messageId,'13900000000'),'default');
 const id=f.messages.at(-1).messageId;
 assert.equal(await f.recovery.handle(f.reply('unrelated','012345'),'default'),false);
 assert.equal(await f.recovery.handle(f.reply(id,'012345'),'yuexia'),false);
 await f.recovery.handle(f.reply(id,'012345',{user_id:'199999999'}),'default');
 await f.recovery.handle(f.reply(id,'012345',{message_type:'group',group_id:c.groupId}),'default');
 await f.recovery.handle(f.reply(id,'12345'),'default');assert.equal(f.calls.length,1);
 assert.equal(f.messages.at(-1).text.includes('6位'),true);
});
test('waiting SMS survives restart; permission revocation cancels continuation',async t=>{
 const f=await fixture(t);await f.trigger();await f.recovery.handle(f.reply(f.messages.at(-1).messageId,'13900000000'),'default');
 const id=f.messages.at(-1).messageId;
 const restarted=new XhsSmsRecovery(f.options);f.revoke();
 await restarted.handle(f.reply(id,'012345'),'default');await restarted.tick();assert.equal(f.resumed.length,0);
 assert.equal(restarted.state.tasks.every(t=>t.status==='cancelled'),true);
});
test('expired and invalid codes are consumed, never resend automatically or replay failed login',async t=>{
 const f=await fixture(t);await f.trigger();await f.recovery.handle(f.reply(f.messages.at(-1).messageId,'13900000000'),'default');
 const id=f.messages.at(-1).messageId;f.advance(600001);await f.recovery.tick();
 await f.recovery.handle(f.reply(id,'012345'),'default');assert.equal(f.calls.length,1);assert.equal(f.recovery.state.flow.status,'expired');
 const next={...c,requestId:'request-new'};f.remember(next);assert.equal((await f.recovery.observe(failure,next)).status,'cooldown');
});
test('challenge during SMS stops without replaying OTP; interrupted checks are never resumed',async t=>{
 const f=await fixture(t);await f.trigger();await f.recovery.handle(f.reply(f.messages.at(-1).messageId,'13900000000'),'default');
 const id=f.messages.at(-1).messageId;f.error(Object.assign(new Error('challenge'),{code:'challenge_required'}));
 await f.recovery.handle(f.reply(id,'012345'),'default');assert.equal(f.recovery.state.flow.error,'challenge_required');
 await f.recovery.handle(f.reply(id,'012345'),'default');assert.equal(f.calls.length,2);assert.equal(f.resumed.length,0);
 f.recovery.state.flow.status='checking';f.recovery.save();const restarted=new XhsSmsRecovery(f.options);assert.equal(restarted.state.flow.status,'interrupted');
});
test('post-login endpoint refusal never starts another login loop',async t=>{
 const f=await fixture(t);f.remember();const task=f.recovery.state.tasks[0];task.attempted=true;
 const result=await f.recovery.observe(failure,c);assert.equal(result.status,'blocked_after_login');assert.equal(f.messages.length,0);
});
test('recovery clears only same-owner challenge failures; sends, successful reads, cancellation and revocation survive',async t=>{
 const f=await fixture(t),service=await XhsService.create({dataDir:join(f.dir,'xhs'),backend:{close:async()=>{}}}),store=new OperationStore(join(f.dir,'ops.db'));
 t.after(async()=>{await service.close();store.close();});
 service.store.db.exec('CREATE TABLE onebot_request_owners(request TEXT PRIMARY KEY,origin TEXT,peer TEXT)');
 const origin={accountId:'xhs-default',scope:`onebot:default:group:${c.groupId}:${c.senderId}`,actorId:c.senderId,requestId:c.requestId},key=service.context(origin);
 service.store.request(key);service.store.stop(key,'challenge_required');service.store.db.prepare('INSERT INTO onebot_request_owners VALUES(?,?,?)').run(key,JSON.stringify(origin),origin.scope);
 const job=service.store.enqueue(key,'download_images',{origin,image_ids:[]});service.store.db.prepare("UPDATE jobs SET state='failed',error=? WHERE id=?").run(JSON.stringify({code:'challenge_required'}),job.job_id);
 function op(id,state,xhs,overrides={}){store.begin('xhs_search_posts',{origin:{...c,...overrides},params:{query:id}},id);store.state(id,state,{xhs});}
 op('partial-inspect','succeeded',{ok:true,data:{resources:[{error:{code:'challenge_required',status:461}}]}});op('blocked','failed',failure);op('read','succeeded',{ok:true,data:{posts:[]}});op('other','failed',failure,{senderId:'199999999'});op('revoked','failed',{ok:false,error:{code:'authorization_revoked'}});op('cancelled','cancelled',failure);
 const previous=await prepareXhsResume(c,{service,store,authorize:async()=>true});
 assert.equal(service.store.terminal(key),null);assert.equal(service.store.job(key,job.job_id).state,'queued');assert.equal(store.get('blocked').state,'pending');assert.equal(store.get('partial-inspect').state,'pending');
 for(const [id,state] of [['read','succeeded'],['other','failed'],['revoked','failed'],['cancelled','cancelled']])assert.equal(store.get(id).state,state);
 assert.equal(previous.find(x=>x.tool==='xhs_search_posts'&&x.params.query==='blocked').status,'retry_after_login');
 await assert.rejects(prepareXhsResume(c,{service,store,authorize:async()=>false}));
});
test('trusted continuation cannot invoke shell, TTS or another business feature',()=>{
 const policy=loadFeatureConfig(),context={...c,xhsRecoveryOnly:true};
 for(const tool of ['exec','read','message','tts_synthesize','quota_query','reminder_create'])assert.equal(decideFeatureTool(policy,tool,{},context).allowed,false);
 assert.equal(decideFeatureTool(policy,'xhs_search_posts',{},context).allowed,true);
});

test('failed business search resumes with the same trusted operation and reaches a real success result after SMS',async t=>{
 const f=await fixture(t);let blocked=true,searches=0;
 const {XhsError}=await import('../src/src/xhs/errors.js');
 const service=await XhsService.create({dataDir:join(f.dir,'resume-xhs'),backend:{search:async()=>{searches++;if(blocked)throw new XhsError('challenge_required',{status:461});return [];},close:async()=>{}},authorize:async()=>true});
 service.store.db.exec('CREATE TABLE onebot_request_owners(request TEXT PRIMARY KEY,origin TEXT,peer TEXT)');
 const store=new OperationStore(join(f.dir,'resume-operations.db'));t.after(async()=>{await service.close();store.close();});
 const execute=context=>executeBusinessTool({name:'xhs_search_posts',params:{query:'爱莉西雅',limit:12},context,sessionKey:'sms-search-fixture',callId:'tool-call',store,
  xhsExecute:(op,params,context,options)=>executeXhsOperation(op,params,context,{...options,service})});
 const other={...c,requestId:'request-b'};
 for(const context of [c,other]) {f.remember(context);const value=await execute(context);assert.equal(value.details.status,'failed');await f.recovery.observe(value.details.xhs,context);f.recovery.finish(context);}
 await f.recovery.flight;assert.equal(searches,2);
 const resumeResults=[];
 f.recovery.resume=()=>async task=>{
  await prepareXhsResume(task.context,{service,store,authorize:async()=>true});
  const value=await execute(task.context);resumeResults.push(value);assert.equal(value.details.status,'succeeded');assert.equal(value.details.xhs.ok,true);
 };
 await f.recovery.handle(f.reply(f.messages.at(-1).messageId,'13900000000'),'default');blocked=false;
 await f.recovery.handle(f.reply(f.messages.at(-1).messageId,'012345'),'default');await f.recovery.tick();
 assert.equal(searches,4);assert.equal(resumeResults.length,2);
 const replay=await execute(c);assert.equal(replay.details.status,'succeeded');assert.equal(searches,4);
 assert.equal(store.db.prepare('SELECT count(*) n FROM operations').get().n,2);
});

test('slow SMS notification does not hold an XHS tool invocation open',async t=>{
 const f=await fixture(t);let release;
 f.recovery.send=async()=>new Promise(resolve=>{release=()=>resolve({messageId:'slow-admin-prompt'});});
 f.remember();await f.recovery.observe(failure,c);const other={...c,requestId:'request-b'};f.remember(other);
 const result=await Promise.race([f.recovery.observe(failure,other),new Promise((_,reject)=>setTimeout(()=>reject(new Error('tool blocked')),50))]);
 assert.equal(result.status,'pending');assert.equal(f.recovery.busy,true);release();await f.recovery.flight;assert.equal(f.recovery.busy,false);
});

test('one login_required triggers a reason-specific private phone request and joins subsequent requests',async t=>{
 const f=await fixture(t);f.remember();
 const lost={operation:'search',ok:false,error:{code:'login_required',upstream_code:-100}};
 const result=await observeXhsAuthResult(lost,c,{smsEnabled:()=>true,observe:(r,c)=>f.recovery.observe(r,c),verify:()=>assert.fail('SMS was bypassed')});
 assert.equal(result.sms_recovery.status,'pending');await f.recovery.flight;
 assert.equal(f.recovery.state.flow.reason,'login_required');assert.equal(f.recovery.state.flow.status,'need_phone');
 assert.equal(f.recovery.state.hits.length,0);assert.equal(f.messages.length,1);assert.match(f.messages[0].text,/登录已失效/);assert.doesNotMatch(f.messages[0].text,/461/);
 const other={...c,requestId:'joined-login'};f.remember(other);
 await f.recovery.observe({...lost,error:{code:'login_required',stopped_in_request:true}},other);
 assert.equal(f.messages.length,1);assert.equal(f.recovery.state.tasks.find(t=>t.context.requestId===other.requestId).flow,f.recovery.state.flow.id);
 await f.recovery.handle(f.reply(f.messages[0].messageId,'13900000000'),'default');
 await f.recovery.handle(f.reply(f.messages.at(-1).messageId,'012345'),'default');
 f.recovery.finish(c);f.recovery.finish(other);await f.recovery.tick();assert.equal(f.resumed.length,2);assert.equal(f.calls.length,2);
});

test('login recovery observes nested errors; invalid local sessions and access refusals do not request SMS',async t=>{
 const f=await fixture(t);f.remember();
 const observed=[];
 for(const r of [
  {operation:'inspect',ok:true,data:{resources:[{error:{code:'login_required'}}]}},
  {operation:'job_status',ok:true,data:{state:'failed',error:{code:'login_required'}}},
 ]) {
  const result=await observeXhsAuthResult(r,c,{smsEnabled:()=>true,observe:async value=>{observed.push(value);return {status:'pending'};}});
  assert.equal(result.sms_recovery.status,'pending');
 }
 assert.equal(observed.length,2);
 for(const code of ['session_invalid','permission_denied','rate_limited','authorization_revoked']) {
  assert.equal(await f.recovery.observe({operation:'search',ok:false,error:{code}},c),null);
 }
 assert.equal(f.messages.length,0);assert.equal(f.recovery.state.flow,null);
});

test('login_required preserves hourly cooldown and never loops after recovery',async t=>{
 const f=await fixture(t);f.remember();const lost={operation:'search',ok:false,error:{code:'login_required'}};
 await f.recovery.observe(lost,c);await f.recovery.flight;f.advance(600001);await f.recovery.tick();
 const other={...c,requestId:'cooldown-login'};f.remember(other);
 assert.equal((await f.recovery.observe(lost,other)).status,'cooldown');
 const resumed={...c,requestId:'already-tried'};f.recovery.remember(resumed,{recovery:true});
 assert.equal((await f.recovery.observe(lost,resumed)).status,'blocked_after_login');
 assert.equal(f.calls.length,0);
});

test('login_required failed workflow resumes its original operation and download job without resetting completed or forbidden work',async t=>{
 const f=await fixture(t);let blocked=true,searches=0;
 const {XhsError}=await import('../src/src/xhs/errors.js');
 const service=await XhsService.create({dataDir:join(f.dir,'expired-xhs'),backend:{search:async()=>{searches++;if(blocked)throw new XhsError('login_required',{upstream_code:-100});return [];},close:async()=>{}},authorize:async()=>true});
 service.store.db.exec('CREATE TABLE onebot_request_owners(request TEXT PRIMARY KEY,origin TEXT,peer TEXT)');
 const store=new OperationStore(join(f.dir,'expired-operations.db'));t.after(async()=>{await service.close();store.close();});
 const execute=()=>executeBusinessTool({name:'xhs_media_workflow',params:{query:'爱莉西雅cos',post_count:2,media_type:'image',rank:'likes'},context:c,sessionKey:'expired-session',callId:'expired-tool-call',store,
  xhsExecute:(op,params,context,options)=>executeXhsOperation(op,params,context,{...options,service})});
 f.remember();const value=await execute();assert.equal(value.details.xhs.error.code,'login_required');
 await observeXhsAuthResult(value.details.xhs,c,{smsEnabled:()=>true,observe:(r,c)=>f.recovery.observe(r,c)});await f.recovery.flight;
 const original=store.db.prepare("SELECT id FROM operations WHERE kind='xhs_media_workflow'").get().id;
 const owner=service.store.db.prepare('SELECT request,origin FROM onebot_request_owners').get();
 const job=service.store.enqueue(owner.request,'download_images',{origin:JSON.parse(owner.origin),image_ids:[]});
 service.store.db.prepare("UPDATE jobs SET state='failed',error=? WHERE id=?").run(JSON.stringify({code:'login_required'}),job.job_id);
 store.begin('xhs_search_posts',{origin:c,params:{query:'completed'}},'completed');store.state('completed','succeeded',{xhs:{ok:true,data:{posts:[]}}});
 store.begin('xhs_search_posts',{origin:c,params:{query:'denied'}},'denied');store.state('denied','failed',{xhs:{ok:false,error:{code:'permission_denied'}}});
 const partial={...c,requestId:'different-request'};store.begin('xhs_search_posts',{origin:partial,params:{query:'other'}},'other');store.state('other','failed',{xhs:{ok:false,error:{code:'login_required'}}});
 f.recovery.resume=()=>async task=>{
  await prepareXhsResume(task.context,{service,store,authorize:async()=>true});
  assert.equal(service.store.terminal(owner.request),null);assert.equal(service.store.job(owner.request,job.job_id).state,'queued');
  assert.equal(store.get(original).state,'pending');assert.equal(store.get('completed').state,'succeeded');assert.equal(store.get('denied').state,'failed');assert.equal(store.get('other').state,'failed');
  const resumed=await execute();assert.equal(resumed.details.xhs.error.code,'no_matching_posts'); // authenticated search ran; fixture has no media
 };
 await f.recovery.handle(f.reply(f.messages.at(-1).messageId,'13900000000'),'default');blocked=false;
 await f.recovery.handle(f.reply(f.messages.at(-1).messageId,'012345'),'default');f.recovery.finish(c);await f.recovery.tick();
 assert.equal(searches,2);assert.equal(f.recovery.state.tasks[0].status,'resumed');assert.equal(f.calls.length,2);
});

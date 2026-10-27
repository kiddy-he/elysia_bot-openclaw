import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import{tmpdir}from'node:os';
import{join}from'node:path';
import{trustedBusinessImageApproval,boundedBusinessReview}from'../src/src/features/business-approval.js';
import{BUSINESS_TOOLS}from'../src/src/features/catalog.js';
import{OperationStore}from'../src/src/access/operations.js';
import{bindFeatureTurn}from'../src/src/feature-tools.js';
import{registerBusinessTools,setBusinessApprovalReviewer,setBusinessApprovalHandler,setBusinessResultHandler,cancelBusinessReviews,recoverBusinessReviews,executeBusinessTool}from'../src/src/features/tools.js';
const owner={senderId:'700000003',accountId:'default',scope:'group',groupId:'700000011',explicit:true,roleCount:1};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,{reviewTimeoutMs=5000,executeReviewed}={}){
 const dir=mkdtempSync(join(tmpdir(),'business-review-')),store=new OperationStore(join(dir,'ops.sqlite')),sessionKey='test:'+dir;
 const release=bindFeatureTurn(sessionKey,{...owner,requestId:dir});const hooks={};
 registerBusinessTools({registerTool(){},on(name,fn){hooks[name]=fn;},logger:{info(){},error(){}}},{getStore:()=>store,reviewTimeoutMs,...(executeReviewed?{executeReviewed}:{})});
 t.after(()=>{cancelBusinessReviews({sessionKey});release();setBusinessApprovalReviewer(undefined);setBusinessApprovalHandler('default',undefined);setBusinessResultHandler('default',undefined);store.close();rmSync(dir,{recursive:true,force:true});});
 return{store,dir,sessionKey,hook:event=>hooks.before_tool_call(event,{sessionKey})};
}
test('trusted image rules match exact structured executors, preserve literal prompt text and reject command substitution',()=>{
 const prompt="美食 'single' \"double\"; $(touch /tmp/not-executed)\n`id`";
 const generated=BUSINESS_TOOLS.onebot_image_generate.build({prompt});
 assert.equal(trustedBusinessImageApproval('onebot_image_generate',generated).decision,'allow');
 for(const command of [{...generated,file:'/bin/sh'},{...generated,argv:['-c',...generated.argv]},{...generated,argv:[generated.argv[0]+'x',...generated.argv.slice(1)]},{...generated,argv:[...generated.argv,'extra']},{...generated,argv:[generated.argv[0],'restart',prompt]}])assert.equal(trustedBusinessImageApproval('onebot_image_generate',command),undefined);
 assert.equal(trustedBusinessImageApproval('network_control',generated),undefined);
 for(const character of ['爱莉希雅','爱莉希雅，月下'])assert.equal(trustedBusinessImageApproval('image_reference',BUSINESS_TOOLS.image_reference.build({character,prompt})).decision,'allow');
});
test('image hook bypasses slow reviewers and grants only one exact execution',async t=>{
 const f=fixture(t);let reviews=0,approvals=0,calls=0;setBusinessApprovalReviewer(async()=>{reviews++;throw Error('must not review fixed image');});setBusinessApprovalHandler('default',async()=>approvals++);
 const event={toolName:'onebot_image_generate',toolCallId:'image',params:{prompt:'美食 $(not-shell)'}};
 assert.equal(await f.hook(event),undefined);assert.equal(reviews,0);assert.equal(approvals,0);
 const op=f.store.db.prepare('SELECT * FROM operations').get();
 const run=async(file,argv,opts)=>{calls++;assert.equal(file,'/bin/bash');assert.equal(opts.shell,false);assert.equal(argv[2],event.params.prompt);return{stdout:'ok'};};
 const input={name:event.toolName,params:event.params,context:{...owner,requestId:f.dir},sessionKey:f.sessionKey,callId:'image',store:f.store,run};
 assert.equal((await executeBusinessTool(input)).details.status,'succeeded');assert.equal((await executeBusinessTool(input)).details.status,'succeeded');assert.equal(calls,1);
 assert.equal(f.store.consumeApproval(op.id,op.fingerprint),false);
});
test('image edit uses turn-owned file and rejects a foreign path before approval',async t=>{
 const f=fixture(t),image=join(f.dir,'owned.png');writeFileSync(image,'fixture');
 assert.equal(trustedBusinessImageApproval('image_edit',BUSINESS_TOOLS.image_edit.build({image,prompt:'光线'},{mediaPaths:[image]})).decision,'allow');
 const blocked=await f.hook({toolName:'image_edit',toolCallId:'foreign',params:{image,prompt:'光线'}});assert.equal(blocked.block,true);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM approvals').get().n,0);
});
test('slow general review returns immediately, deduplicates and requests one manual approval without execution',async t=>{
 const f=fixture(t);let finish,reviews=0,deliveries=0,executions=0;setBusinessApprovalReviewer(async()=>{reviews++;return new Promise(r=>finish=r);});setBusinessApprovalHandler('default',async()=>deliveries++);setBusinessResultHandler('default',async()=>executions++);
 const event={toolName:'network_control',toolCallId:'first',params:{action:'restart'}};
 assert.equal((await f.hook(event)).block,true);await tick();assert.equal(reviews,1);assert.equal(deliveries,0);assert.equal(f.store.db.prepare('SELECT state FROM operations').get().state,'reviewing');
 await f.hook({...event,toolCallId:'again'});assert.equal(reviews,1);finish({decision:'allow'});await tick();assert.equal(deliveries,1);assert.equal(executions,0);assert.equal(f.store.db.prepare('SELECT state FROM operations').get().state,'waiting_approval');
});
test('timed out reviewer cannot later approve or send an approval prompt',async t=>{
 const f=fixture(t,{reviewTimeoutMs:15});let finish,signal,prompts=0;const results=[];
 setBusinessApprovalReviewer(async value=>{signal=value.signal;return new Promise(r=>finish=r);});setBusinessApprovalHandler('default',async()=>prompts++);setBusinessResultHandler('default',async r=>results.push(r));
 await f.hook({toolName:'network_control',toolCallId:'timeout',params:{action:'restart'}});
 await new Promise(r=>setTimeout(r,30));assert.equal(signal.aborted,true);assert.equal(f.store.db.prepare('SELECT state FROM operations').get().state,'review_expired');assert.equal(prompts,0);assert.equal(results.length,1);
 finish({decision:'allow'});await tick();assert.equal(prompts,0);assert.equal(results.length,1);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM approvals').get().n,0);
});
test('cancelled review ignores late decision and never sends or executes',async t=>{
 const f=fixture(t);let finish,prompts=0;setBusinessApprovalReviewer(async()=>new Promise(r=>finish=r));setBusinessApprovalHandler('default',async()=>prompts++);setBusinessResultHandler('default',async()=>prompts++);
 await f.hook({toolName:'network_control',toolCallId:'cancel',params:{action:'restart'}});await tick();assert.equal(cancelBusinessReviews({sessionKey:f.sessionKey}).length,1);finish({decision:'allow'});await tick();assert.equal(f.store.db.prepare('SELECT state FROM operations').get().state,'review_cancelled');assert.equal(prompts,0);
});
test('authorized non-manual operation resumes once after review and reports result',async t=>{
 let executions=0;const f=fixture(t,{executeReviewed:async input=>{executions++;assert.equal(input.context.senderId,owner.senderId);assert.equal(input.store.consumeApproval(input.store.db.prepare('SELECT id FROM operations').get().id,input.store.db.prepare('SELECT fingerprint FROM operations').get().fingerprint),true);input.store.state(input.store.db.prepare('SELECT id FROM operations').get().id,'succeeded');return{details:{status:'succeeded'}};}});
 setBusinessApprovalReviewer(async()=>({decision:'allow'}));const results=[];setBusinessResultHandler('default',async value=>results.push(value));
 await f.hook({toolName:'downloads_control',toolCallId:'review',params:{action:'start',hash:'a'.repeat(40)}});await tick();assert.equal(executions,1);assert.equal(results.length,1);
});
test('bounded review signals cancellation even when reviewer ignores it',async()=>{
 let signal;await assert.rejects(boundedBusinessReview(s=>{signal=s;return new Promise(()=>{});},{timeoutMs:5}),/超时/u);assert.equal(signal.aborted,true);
});

test('restart recovery cancels orphan reviews and never replays external operations', t=>{
 const f=fixture(t);
 f.store.begin('network_control',{origin:{accountId:'default',sessionKey:f.sessionKey}},'orphan');
 f.store.state('orphan','reviewing');
 assert.equal(recoverBusinessReviews('default',f.store),1);
 assert.equal(f.store.get('orphan').state,'review_cancelled');
 assert.equal(recoverBusinessReviews('default',f.store),0);
});

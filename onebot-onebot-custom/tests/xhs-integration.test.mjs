import './helpers/legacy-xhs-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {XhsService} from '../src/src/xhs/service.js';
import {XhsError} from '../src/src/xhs/errors.js';
import {loadFeatureConfig,authorizeFeature} from '../src/src/feature-policy.js';
import {executeXhsOperation,resolveXhsContext,authorizeXhs,xhsToolContext} from '../src/src/features/xhs.js';
import {executeBusinessTool,registerBusinessTools} from '../src/src/features/tools.js';
import {OperationStore} from '../src/src/access/operations.js';
import {DeliveryQueue} from '../src/src/delivery/queue.js';
import {toolProgressState} from '../src/src/task-progress.js';
import {bindFeatureTurn,decideFeatureTool,registerFeatureToolGuard} from '../src/src/feature-tools.js';
import {isolateRoute} from '../src/src/workspaces/routes.js';
const policy=loadFeatureConfig();
const owner={accountId:'default',scope:'private',senderId:'700000003',requestId:'xhs-fixture'};
const id='0123456789abcdef01234567',url=`https://www.xiaohongshu.com/explore/${id}?xsec_token=synthetic`;
async function fixture(t) {
 const dir=await mkdtemp(join(tmpdir(),'onebot-xhs-'));
 const note={noteId:id,type:'normal',title:'测试cos',desc:'外部内容',user:{userId:'author',nickname:'博主'},interactInfo:{likedCount:'168'},imageList:[{urlDefault:'https://sns-webpic-qc.xhscdn.com/test.png',width:2,height:2}],tagList:[]};
 const bytes=await sharp({create:{width:2,height:2,channels:3,background:'#fff'}}).png().toBuffer();
 const service=await XhsService.create({dataDir:join(dir,'xhs'),completeAlbums:true,backend:{inspect:async()=>({source_url:url,note}),search:async()=>[],close:async()=>{}},
  downloader:{get:async(_url,{output})=>{await writeFile(output,bytes);return {bytes:bytes.length};}},authorize:async(o,op)=>authorizeXhs(o,op),authorizeJob:async(o,op)=>authorizeXhs(o,op)});
 service.store.db.exec('CREATE TABLE onebot_request_owners(request TEXT PRIMARY KEY,origin TEXT NOT NULL,peer TEXT NOT NULL)');
 const store=new OperationStore(join(dir,'business.db'));let sends=0;
 const queue=new DeliveryQueue({store,policy:()=>policy,config:async()=>({}),send:async()=>{sends++;return{status:'sent',receipt:{primaryPlatformMessageId:'qq-fixture-1'}};}});
 t.after(async()=>{await service.close();store.close();await rm(dir,{recursive:true,force:true});});
 return{service,queue,store,get sends(){return sends;}};
}
test('XHS grants content tools including batch media to users to users in private and configured groups on both accounts',()=>{
 let decisions=0;
 for(const accountId of ['default','yuexia'])for(const scope of ['private','group'])for(const senderId of ['700000003','188888888'])for(const action of ['read','media']) {
 const c={...owner,accountId,scope,senderId,groupId:'700000012',explicit:true,roleCount:1};
 assert.equal(authorizeFeature(policy,'xiaohongshu',action,c).allowed,scope==='private'||policy.accounts[accountId].groupIds.includes(c.groupId));decisions++;
 }
 assert.equal(xhsToolContext({...owner,actorType:'service'}),false);assert.equal(xhsToolContext({...owner,requestId:undefined}),false);
});
test('XHS real queued download, durable cross-turn handles and QQ receipt, no repeated send',async t=>{
 const f=await fixture(t);
 const list=await executeXhsOperation('list_images',{ref_id:url},owner,{service:f.service});assert.equal(list.ok,true);
 const download=await executeXhsOperation('download_images',{image_ids:[list.data.images[0].image_id]}, {...owner,requestId:'later'}, {service:f.service});
 assert.equal(download.data.state,'queued');await f.service.runPending();
 const status=await executeXhsOperation('job_status',{job_id:download.data.job_id},{...owner,requestId:'next-turn'},{service:f.service});
 assert.equal(status.data.state,'succeeded');assert.equal(status.data.result.artifacts.length,1);
 const params={artifact_id:status.data.result.artifacts[0].artifact_id};
 const result=await executeXhsOperation('artifact',params,owner,{service:f.service,queue:f.queue,operationId:'op-1'});
 assert.equal(result.data.delivery_status,'staged_for_forward');assert.equal(f.sends,0);assert.equal(result.data.path,undefined);
 const sent=await executeXhsOperation('send_media',{},owner,{service:f.service,queue:f.queue,operationId:'op-1'});
 assert.equal(sent.data.delivery_status,'delivered');assert.equal(sent.data.receipt.primaryPlatformMessageId,'qq-fixture-1');
 await executeXhsOperation('send_media',{},owner,{service:f.service,queue:f.queue,operationId:'op-2'});assert.equal(f.sends,1);
 await assert.rejects(executeXhsOperation('artifact',params,owner,{service:f.service}),/已提交/);
 const stored=JSON.parse(f.store.db.prepare('SELECT request FROM deliveries').get().request);
 assert.equal(stored.parts.length,1);assert.equal(stored.parts[0].type,'forward');assert.equal(stored.parts[0].nodes.length,1);assert.equal(stored.parts[0].nodes[0].media.length,1);
 assert.notEqual(stored.parts[0].nodes[0].media[0].path,status.data.result.artifacts[0].path);
 assert.throws(()=>resolveXhsContext(f.service,{...owner,accountId:'yuexia'},'artifact',params),/不属于/);
 await assert.rejects(executeXhsOperation('artifact',params,{...owner,scope:'group',groupId:'700000012'},{service:f.service,queue:f.queue}),/不属于当前用户和会话/);
});
test('queued XHS work checks revoked capability before downloading',async t=>{
 const f=await fixture(t);const list=await executeXhsOperation('list_images',{ref_id:url},owner,{service:f.service});
 const job=await executeXhsOperation('download_images',{image_ids:[list.data.images[0].image_id]},owner,{service:f.service});
 f.service.authorizeJob=async()=>false;await f.service.runPending();
 const state=await executeXhsOperation('job_status',{job_id:job.data.job_id},owner,{service:f.service});
 assert.equal(state.data.state,'cancelled');assert.equal(state.data.error.code,'authorization_revoked');assert.equal(f.sends,0);
});
test('job status refreshes for new model calls; download queue insertion remains idempotent',async t=>{
 const f=await fixture(t);let calls=0;
 const input={name:'xhs_job_status',params:{job_id:'job-fixture'},context:owner,sessionKey:'xhs-poll',store:f.store,
  xhsExecute:async()=>({ok:true,data:{state:++calls===1?'queued':'succeeded'}})};
 assert.equal((await executeBusinessTool({...input,callId:'poll-1'})).details.xhs.data.state,'queued');
 assert.equal((await executeBusinessTool({...input,callId:'poll-2'})).details.xhs.data.state,'succeeded');assert.equal(calls,2);
 const queueInput={...input,name:'xhs_download_video',params:{ref_id:url},xhsExecute:async()=>{calls++;return{ok:true,data:{state:'queued'}};}};
 await executeBusinessTool({...queueInput,callId:'download-1'});await executeBusinessTool({...queueInput,callId:'download-2'});assert.equal(calls,3);
 await assert.rejects(executeBusinessTool({...queueInput,context:{...owner,internal:true,scope:'group',groupId:'700000012'},callId:'forged'}),/permission denied/);
 await assert.rejects(executeBusinessTool({...queueInput,params:{ref_id:url,scope:'private'},callId:'bad-param'}),/invalid_request/);
});
test('challenge remains a terminal request failure and never becomes an empty successful search',async t=>{
 const f=await fixture(t);let count=0;f.service.backend.search=async()=>{count++;throw new XhsError('challenge_required');};
 const first=await executeXhsOperation('search',{query:'cos'},owner,{service:f.service});const second=await executeXhsOperation('search',{query:'another'},owner,{service:f.service});
 assert.equal(first.error.code,'challenge_required');assert.equal(second.error.code,'challenge_required');assert.equal(count,1);
});
test('tool factory requires trusted event identity and exposes XHS to configured groups and guest private chats',async t=>{
 const factories=new Map();registerBusinessTools({registerTool:(fn,{names})=>factories.set(names[0],fn),on:()=>{}});
 const fn=factories.get('xhs_search_posts');assert.equal(fn({sessionKey:'unbound'}),null);
 for(const [senderId,scope,allowed] of [['700000003','private',true],['700000003','group',true],['188888888','private',true],['188888888','group',true]]) {
 const sessionKey=`test:${senderId}:${scope}`;const release=bindFeatureTurn(sessionKey,{...owner,senderId,scope,groupId:'700000012',explicit:true,roleCount:1});
 try{assert.equal(Boolean(fn({sessionKey})),allowed);}finally{release();}
 }
});

test('XHS progress distinguishes queued downloads and unconfirmed sends from completion',()=>{
 const event=(toolName,data)=>({toolName,result:{details:{status:'succeeded',xhs:{ok:true,data}}}});
 assert.equal(toolProgressState(event('xhs_download_video',{state:'queued'})),'running');
 assert.equal(toolProgressState(event('xhs_job_status',{state:'failed'})),'failed');
 assert.equal(toolProgressState(event('xhs_job_status',{state:'succeeded'})),'completed');
 assert.equal(toolProgressState(event('xhs_read_artifact',{delivery_status:'native_pending'})),'uncertain');
 assert.equal(toolProgressState(event('xhs_send_media',{delivery_status:'delivered',receipt:{primaryPlatformMessageId:'qq-1'}})),'completed');
});

test('classified XHS content turns cannot escape into shell, file inspection, other business or native web tools',()=>{
 const context={...owner,xiaohongshuOperation:true};
 for(const name of ['exec','read','write','process','quota_query','qzone_read','web_search','web_fetch','message'])assert.equal(decideFeatureTool(policy,name,{},context).allowed,false,name);
 assert.equal(decideFeatureTool(policy,'xhs_search_posts',{},context).allowed,true);
 assert.equal(decideFeatureTool(policy,'xhs_search_posts',{}, {...context,scope:'group',groupId:'700000012'}).allowed,true);
});

test('forward queue persists mixed image/video nodes as one payload; rejects extra content and destinations',async t=>{
 const f=await fixture(t);const path=join(tmpdir(),`xhs-forward-${Date.now()}.mp4`);await writeFile(path,Buffer.from('fixture'));
 t.after(()=>rm(path,{force:true}));
 const request={feature:'xiaohongshu',action:'media',accountId:owner.accountId,target:{type:'private',id:owner.senderId},context:owner,
   dedupeKey:'mixed-forward',parts:[{type:'forward',nodes:[{media:[{type:'image',path},{type:'video',path}]}]}]};
 let payloads=[];f.queue.send=async args=>{payloads=args.payloads;return{status:'sent',receipt:{primaryPlatformMessageId:'mixed-1'}};};
 await f.queue.enqueue(request);const row=f.store.db.prepare('SELECT request FROM deliveries').get();
 const stored=JSON.parse(row.request);assert.equal(stored.parts[0].nodes.length,1);assert.equal(stored.parts[0].nodes[0].media.length,2);assert.equal(payloads.length,1);
 assert.equal(payloads[0].channelData.onebotDelivery.kind,'forward');assert.equal(payloads[0].mediaUrl,undefined);
 await assert.rejects(f.queue.enqueue({...request,dedupeKey:'unsafe',parts:[{type:'forward',nodes:[{media:[{type:'text',path}]}]}]}),/forward/);
 await assert.rejects(f.queue.enqueue({...request,dedupeKey:'unsafe2',parts:[{type:'forward',nodes:[{media:[{type:'image',path,caption:'injected'}]}]}]}),/forward/);
 for (const title of ['', 'x'.repeat(241), {type:'at',qq:'all'}]) {
  await assert.rejects(f.queue.enqueue({...request,dedupeKey:`bad-title-${String(title)}`,parts:[{type:'forward',nodes:[{title,media:[{type:'image',path}]}]}]}),/forward/);
 }
 await assert.rejects(f.queue.enqueue({...request,dedupeKey:'other-peer',target:{type:'private',id:'188888888'}}));
 await f.queue.enqueue(request);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM deliveries').get().n,1);
});

test('uncertain forward result never triggers a second platform send on explicit flush replay',async t=>{
 const f=await fixture(t);const list=await executeXhsOperation('list_images',{ref_id:url},owner,{service:f.service});
 const job=await executeXhsOperation('download_images',{image_ids:[list.data.images[0].image_id]},owner,{service:f.service});
 await f.service.runPending();const status=await executeXhsOperation('job_status',{job_id:job.data.job_id},owner,{service:f.service});
 await executeXhsOperation('artifact',{artifact_id:status.data.result.artifacts[0].artifact_id},owner,{service:f.service});
 let calls=0;f.queue.send=async()=>{calls++;throw new Error('response lost after send');};
 for(let i=0;i<2;i++){
  const result=await executeXhsOperation('send_media',{},owner,{service:f.service,queue:f.queue,operationId:`flush-${i}`});
  assert.equal(result.data.delivery_status,'uncertain');assert.equal(result.data.receipt,undefined);
 }
 assert.equal(calls,1);await f.queue.recover();assert.equal(calls,1);
});

test('revoking admin media permission after staging prevents forward platform delivery',async t=>{
 const f=await fixture(t);const list=await executeXhsOperation('list_images',{ref_id:url},owner,{service:f.service});
 const job=await executeXhsOperation('download_images',{image_ids:[list.data.images[0].image_id]},owner,{service:f.service});
 await f.service.runPending();const status=await executeXhsOperation('job_status',{job_id:job.data.job_id},owner,{service:f.service});
 await executeXhsOperation('artifact',{artifact_id:status.data.result.artifacts[0].artifact_id},owner,{service:f.service});
 const revoked=structuredClone(policy);revoked.features.xiaohongshu.actions.media.enabled=false;f.queue.policy=()=>revoked;
 await assert.rejects(executeXhsOperation('send_media',{},owner,{service:f.service,queue:f.queue}),/feature disabled/);
 assert.equal(f.sends,0);
});

// More than one list_images page must still produce a complete, ordered post node.
test('selecting one image automatically downloads its entire 23-image post; different posts remain separate nodes in one forward',async t=>{
 const f=await fixture(t),second='abcdef0123456789abcdef01';
 const url2=`https://www.xiaohongshu.com/explore/${second}?xsec_token=synthetic`;
 f.service.backend.inspect=async source=>{
  const postId=source.includes(second)?second:id,count=postId===id?23:3;
  return{source_url:source,note:{noteId:postId,type:'normal',title:postId===id?'第一帖：完整23图':'第二帖：完整3图',user:{userId:'author'},imageList:Array.from({length:count},(_,i)=>({urlDefault:`https://sns-webpic-qc.xhscdn.com/${postId}-${i}.png`}))}};
 };
 for(const [source,total] of [[url,23],[url2,3]]) {
  const list=await executeXhsOperation('list_images',{ref_id:source},owner,{service:f.service});
  assert.equal(list.data.total,total);assert.equal(list.data.images.length,Math.min(total,20));
  const job=await executeXhsOperation('download_images',{image_ids:[list.data.images[0].image_id]},owner,{service:f.service});
  await f.service.runPending();const state=await executeXhsOperation('job_status',{job_id:job.data.job_id},owner,{service:f.service});
  assert.equal(state.data.state,'succeeded');assert.equal(state.data.result.artifacts.length,total);
  const staged=await executeXhsOperation('artifact',{artifact_id:state.data.result.artifacts[0].artifact_id},owner,{service:f.service});
  assert.equal(staged.data.staged_post_media_count,total);assert.equal(f.sends,0);
 }
 const sent=await executeXhsOperation('send_media',{},owner,{service:f.service,queue:f.queue});assert.equal(sent.data.delivery_status,'delivered');
 const request=JSON.parse(f.store.db.prepare('SELECT request FROM deliveries').get().request);
 assert.equal(f.sends,1);assert.equal(request.parts.length,1);
 assert.deepEqual(request.parts[0].nodes.map(n=>n.media.length),[23,3]);
 assert.deepEqual(request.parts[0].nodes.map(n=>n.title),['第一帖：完整23图','第二帖：完整3图']);
});

test('an incomplete album is refused rather than sending its successfully downloaded subset',async t=>{
 const f=await fixture(t);
 f.service.backend.inspect=async source=>({source_url:source,note:{noteId:id,type:'normal',user:{userId:'author'},imageList:[{urlDefault:'https://sns-webpic-qc.xhscdn.com/good.png'},{urlDefault:'https://sns-webpic-qc.xhscdn.com/bad.png'}]}});
 const get=f.service.downloader.get;f.service.downloader.get=async(u,options)=>{if(u.includes('bad.png'))throw new XhsError('download_failed');return get(u,options);};
 const list=await executeXhsOperation('list_images',{ref_id:url},owner,{service:f.service});
 const job=await executeXhsOperation('download_images',{image_ids:[list.data.images[0].image_id]},owner,{service:f.service});await f.service.runPending();
 const state=await executeXhsOperation('job_status',{job_id:job.data.job_id},owner,{service:f.service});assert.equal(state.data.state,'partial');
 await assert.rejects(executeXhsOperation('artifact',{artifact_id:state.data.result.artifacts[0].artifact_id},owner,{service:f.service}),/尚未全部/);
 const result=await executeXhsOperation('send_media',{},owner,{service:f.service,queue:f.queue});assert.equal(result.data.delivery_status,'nothing_staged');assert.equal(f.sends,0);
});

test('concurrent XHS list_images calls wait FIFO instead of returning busy; one account serializes both personas',async t=>{
 const f=await fixture(t),order=[];let running=0,max=0;
 const xhsExecute=async(_op,params)=>{order.push(params.ref_id);running++;max=Math.max(max,running);await new Promise(r=>setTimeout(r,15));running--;return{ok:true,data:{images:[]}};};
 const outputs=await Promise.all([1,2,3].map((n)=>executeBusinessTool({name:'xhs_list_images',params:{ref_id:url+`&n=${n}`},context:{...owner,accountId:n===2?'yuexia':'default',requestId:`fifo-${n}`},callId:`fifo-${n}`,sessionKey:`fifo-${n}`,store:f.store,xhsExecute})));
 assert.equal(max,1);assert.deepEqual(order,[1,2,3].map(n=>url+`&n=${n}`));assert.ok(outputs.every(x=>x.details.status==='succeeded'));
});

test('cancelled queued XHS request does not execute and does not block following requests',async t=>{
 const f=await fixture(t),controller=new AbortController(),calls=[];let begin,finish;
 const started=new Promise(r=>begin=r),hold=new Promise(r=>finish=r);
 const xhsExecute=async(_op,params)=>{calls.push(params.query);if(params.query==='hold'){begin();await hold;}return{ok:true,data:{posts:[]}};};
 const call=(query,signal)=>executeBusinessTool({name:'xhs_search_posts',params:{query},context:{...owner,requestId:`cancel-${query}`},callId:query,sessionKey:'cancel',store:f.store,signal,xhsExecute});
 const first=call('hold');await started;
 const middle=call('skip',controller.signal);const last=call('last');controller.abort();
 assert.equal((await middle).details.status,'not_executed');finish();await Promise.all([first,last]);assert.deepEqual(calls,['hold','last']);
});

test('permission revoked while an XHS call waits is rechecked before site execution',async t=>{
 const f=await fixture(t);let begin,finish;const started=new Promise(r=>begin=r),hold=new Promise(r=>finish=r);let calls=0;
 const xhsExecute=async()=>{calls++;begin();await hold;return{ok:true,data:{posts:[]}};};
 const context={...owner,requestId:'revocation-wait'};
 const first=executeBusinessTool({name:'xhs_search_posts',params:{query:'hold'},context:owner,callId:'hold',sessionKey:'revocation',store:f.store,xhsExecute});await started;
 const next=executeBusinessTool({name:'xhs_search_posts',params:{query:'wait'},context,callId:'wait',sessionKey:'revocation',store:f.store,xhsExecute});
 context.internal=true;const rejected=assert.rejects(next,/permission denied/);finish();await first;await rejected;assert.equal(calls,1);
});

test('guest private and group member complete the full media workflow to their bound conversation',async t=>{
 const f=await fixture(t);
 const contexts=[{...owner,senderId:'188888888',requestId:'guest-private'},
  ...['700000008','700000011','700000012'].map(groupId=>({...owner,scope:'group',groupId,senderId:'188888888',requestId:`group-${groupId}`}))];
 for(const context of contexts){
  const list=await executeXhsOperation('list_images',{ref_id:url},context,{service:f.service});assert.equal(list.ok,true);
  const job=await executeXhsOperation('download_images',{image_ids:[list.data.images[0].image_id]},context,{service:f.service});await f.service.runPending();
  const state=await executeXhsOperation('job_status',{job_id:job.data.job_id},context,{service:f.service});assert.equal(state.data.state,'succeeded');
  for(const foreign of [{...context,senderId:'199999999'}, {...context,scope:context.scope==='group'?'private':'group',groupId:'700000012'}, {...context,accountId:'yuexia'}]){
   await assert.rejects(executeXhsOperation('job_status',{job_id:job.data.job_id},foreign,{service:f.service}));
  }
  await executeXhsOperation('artifact',{artifact_id:state.data.result.artifacts[0].artifact_id},context,{service:f.service});
  const sent=await executeXhsOperation('send_media',{},context,{service:f.service,queue:f.queue});assert.equal(sent.data.delivery_status,'delivered');
  const request=JSON.parse(f.queue.get(sent.data.delivery_id).request);
  assert.deepEqual(request.target,{type:context.scope,id:String(context.scope==='group'?context.groupId:context.senderId)});
  const forged={...request,dedupeKey:`forged-${context.requestId}`,target:{type:context.scope,id:context.scope==='group'?'700000011':'199999999'}};
  if(forged.target.id!==request.target.id)await assert.rejects(f.queue.enqueue(forged),/forward/);
 }
 assert.equal(f.sends,contexts.length);
 for(const op of ['status','login','logout','publish','comment','like']) assert.equal(authorizeXhs({scope:'onebot:default:private:700000003',actorId:'700000003'},op),false);
});

test('serial XHS executor removes an expired wait and bounds the waiting queue',async()=>{
 const {SerialExecutor}=await import('../src/src/features/serial-executor.js');
 const executor=new SerialExecutor(1);const release=await executor.acquire();
 const deadline=AbortSignal.timeout(15);const wait=executor.acquire(deadline);
 assert.throws(()=>executor.acquire(),/xhs_queue_full/);
 // AbortSignal.timeout uses an unref timer, keep the test alive until it fires.
 const keepAlive=setTimeout(()=>{},1000);
 try{await assert.rejects(wait,{name:'TimeoutError'});}finally{clearTimeout(keepAlive);}
 release();const next=await executor.acquire();next();next();assert.equal(executor.running,false);
});

test('two simultaneous group users complete independent album download and forward flows without identity ambiguity or handle crossover', async t=>{
 const f=await fixture(t),releases=[];
 let guard;registerFeatureToolGuard({on:(name,fn)=>{if(name==='before_tool_call')guard=fn;}});
 const users=['188888888','188888889'].map((senderId,index)=>{
  const route=isolateRoute({}, {scope:'group',conversationId:'700000012',roleAgentId:'main',accountId:'default',senderId});
  const context={...owner,senderId,scope:'group',groupId:'700000012',explicit:true,roleCount:1,requestId:`parallel-xhs-${index}`,xiaohongshuOperation:true,sessionKey:route.sessionKey,workspaceAgentId:route.agentId};
  releases.push(bindFeatureTurn(route.sessionKey,context));return{context,route};
 });
 const names={list_images:'xhs_list_images',download_images:'xhs_download_images',job_status:'xhs_job_status',artifact:'xhs_read_artifact',send_media:'xhs_send_media'};
 let sequence=0;
 const invoke=async(user,operation,params)=>{
  assert.equal(guard({toolName:names[operation],params},{sessionKey:user.route.sessionKey,requester:{senderId:user.context.senderId,accountId:'default'}}),undefined);
  const result=await executeBusinessTool({name:names[operation],params,context:user.context,sessionKey:user.route.sessionKey,callId:`parallel-call-${++sequence}`,store:f.store,
   xhsExecute:(op,args,context,options)=>executeXhsOperation(op,args,context,{...options,service:f.service,queue:f.queue})});
  assert.equal(result.details.xhs?.ok,true,JSON.stringify(result.details));return result.details.xhs.data;
 };
 try{
  const lists=await Promise.all(users.map(user=>invoke(user,'list_images',{ref_id:url})));
  const downloads=await Promise.all(users.map((user,index)=>invoke(user,'download_images',{image_ids:[lists[index].images[0].image_id]})));
  assert.notEqual(downloads[0].job_id,downloads[1].job_id);
  await f.service.runPending();
  const jobs=await Promise.all(users.map((user,index)=>invoke(user,'job_status',{job_id:downloads[index].job_id})));
  assert(jobs.every(job=>job.state==='succeeded'));
  const artifactIds=jobs.map(job=>job.result.artifacts[0].artifact_id);
  await assert.rejects(executeXhsOperation('artifact',{artifact_id:artifactIds[0]},users[1].context,{service:f.service}),/不属于/);
  await Promise.all(users.map((user,index)=>invoke(user,'artifact',{artifact_id:artifactIds[index]})));
  const deliveries=await Promise.all(users.map(user=>invoke(user,'send_media',{})));
  assert(deliveries.every(value=>value.delivery_status==='delivered'&&value.receipt));assert.equal(f.sends,2);
  const rows=f.store.db.prepare('SELECT request FROM deliveries').all().map(row=>JSON.parse(row.request));
  assert.equal(new Set(rows.map(row=>row.sessionKey)).size,2);assert.deepEqual(new Set(rows.map(row=>row.context.senderId)),new Set(users.map(user=>user.context.senderId)));
  assert(rows.every(row=>row.parts[0].type==='forward'&&row.parts[0].nodes.length===1&&row.parts[0].nodes[0].title==='测试cos'));
 }finally{for(const release of releases)release();}
});

test('batch search/download/send uses real service jobs and keeps all images per post in one forward',async t=>{
 const f=await fixture(t),ids=[id,'abcdef0123456789abcdef01','abcdef0123456789abcdef02'];
 f.service.backend.search=async()=>ids.map((post,i)=>({modelType:'note',id:post,xsecToken:'synthetic',noteCard:{type:'normal',displayTitle:`帖子${i}`,interactInfo:{likedCount:String(100-i*10)}}}));
 f.service.backend.inspect=async source=>{const post=ids.find(p=>source.includes(p));return{source_url:source,note:{noteId:post,type:'normal',title:`帖子-${post}`,user:{userId:'author'},imageList:Array.from({length:post===id?23:3},(_,i)=>({urlDefault:`https://sns-webpic-qc.xhscdn.com/${post}-${i}.png`}))}};};
 f.service.start({intervalMs:10});
 const result=await executeXhsOperation('media_workflow',{query:'cos',rank:'likes'},owner,{service:f.service,queue:f.queue,signal:AbortSignal.timeout(10000)});
 assert.equal(result.ok,true,JSON.stringify(result.error));assert.equal(result.data.media_count,29);assert.equal(f.sends,1);
 const sent=JSON.parse(f.store.db.prepare('SELECT request FROM deliveries').get().request);
 assert.deepEqual(sent.parts[0].nodes.map(n=>n.media.length),[23,3,3]);assert(sent.parts[0].nodes.every(n=>n.title.startsWith('帖子-')));
 assert.equal(result.data.posts.length,3);assert(result.data.receipt);
});

test('a batch releases the shared XHS lane during QQ upload so another user can search',async t=>{
 const f=await fixture(t);f.service.start({intervalMs:10});
 let reached,unblock;const uploading=new Promise(r=>reached=r),blocked=new Promise(r=>unblock=r);
 t.after(()=>unblock());f.queue.send=async()=>{reached();await blocked;return {status:'sent',receipt:{primaryPlatformMessageId:'batch'}};};
 const ctx={...owner,requestId:'batch-upload'};
 const batch=executeBusinessTool({name:'xhs_media_workflow',params:{ref_ids:[url]},context:ctx,sessionKey:'batch-session',callId:'batch',store:f.store,
  xhsExecute:(operation,params,context,options)=>executeXhsOperation(operation,params,context,{...options,service:f.service,queue:f.queue})});
 await uploading;
 const other={...owner,senderId:'188888888',requestId:'another-user'};
 const search=await executeBusinessTool({name:'xhs_search_posts',params:{query:'cos'},context:other,sessionKey:'other-session',callId:'search',store:f.store,
  xhsExecute:(operation,params,context,options)=>executeXhsOperation(operation,params,context,{...options,service:f.service,queue:f.queue})});
 assert.equal(search.details.status,'succeeded');unblock();assert.equal((await batch).details.status,'succeeded');
});

test('failed staging removes this batch selections so final gateway fallback cannot send a subset',async t=>{
 const f=await fixture(t),second='abcdef0123456789abcdef01';
 const source2=`https://www.xiaohongshu.com/explore/${second}?xsec_token=synthetic`;
 f.service.backend.inspect=async source=>({source_url:source,note:{noteId:source.includes(second)?second:id,type:'normal',title:'完整图集',user:{userId:'author'},imageList:[{urlDefault:'https://sns-webpic-qc.xhscdn.com/test.png'}]}});
 const execute=f.service.execute.bind(f.service);let staged=0;
 f.service.execute=async(op,...args)=>{if(op==='artifact'&&++staged===2)throw Object.assign(new Error('fixture'),{code:'artifact_integrity_failed'});return execute(op,...args);};
 f.service.start({intervalMs:10});
 const result=await executeXhsOperation('media_workflow',{ref_ids:[url,source2]},owner,{service:f.service,queue:f.queue,signal:AbortSignal.timeout(10000)});
 assert.equal(result.ok,false);assert.equal(f.sends,0);
 const final=await executeXhsOperation('send_media',{},owner,{service:f.service,queue:f.queue});
 assert.equal(final.data.delivery_status,'nothing_staged');assert.equal(f.sends,0);
});

test('batch tool completes under admin/guest private/group identities on both bot accounts without approval',async t=>{
 const f=await fixture(t);f.service.start({intervalMs:10});
 for(const accountId of ['default','yuexia']) for(const scope of ['private','group']) for(const senderId of ['700000003','188888888']) {
  const requestId=`batch-${accountId}-${scope}-${senderId}`;
  const context={...owner,accountId,scope,senderId,groupId:policy.accounts[accountId].groupIds[0],explicit:true,roleCount:1,requestId};
  const r=await executeBusinessTool({name:'xhs_media_workflow',params:{ref_ids:[url]},context,sessionKey:requestId,callId:requestId,store:f.store,
   xhsExecute:(operation,params,context,options)=>executeXhsOperation(operation,params,context,{...options,service:f.service,queue:f.queue})});
  assert.equal(r.details.status,'succeeded',JSON.stringify(r.details));assert.equal(r.details.xhs.data.delivery_status,'delivered');
 }
 assert.equal(f.sends,8);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM approvals').get().n,0);
 const sent=f.store.db.prepare('SELECT request FROM deliveries').all().map(r=>JSON.parse(r.request));
 assert(sent.every(r=>r.target.id===String(r.context.scope==='group'?r.context.groupId:r.context.senderId)));
});

test('download cache reuses verified file bytes while each user gets independent artifact ownership',async t=>{
 const f=await fixture(t);let downloads=0;const original=f.service.downloader.get.bind(f.service.downloader);f.service.downloader.get=(...args)=>{downloads++;return original(...args);};
 const owners=[{...owner,requestId:'cache-a'},{...owner,senderId:'188888888',requestId:'cache-b'}];const artifacts=[];
 for(const c of owners){const l=await executeXhsOperation('list_images',{ref_id:url},c,{service:f.service});const j=await executeXhsOperation('download_images',{image_ids:[l.data.images[0].image_id]},c,{service:f.service});await f.service.runPending();const s=await executeXhsOperation('job_status',{job_id:j.data.job_id},c,{service:f.service});assert.equal(s.data.state,'succeeded');artifacts.push(s.data.result.artifacts[0]);}
 assert.equal(downloads,1);assert.notEqual(artifacts[0].artifact_id,artifacts[1].artifact_id);assert.equal(artifacts[1].download_cache_hit,true);
 await assert.rejects(executeXhsOperation('artifact',{artifact_id:artifacts[0].artifact_id},owners[1],{service:f.service}),/不属于/);
});

test('media download retries a transient transport failure once but never retries an authorization refusal',async t=>{
 for(const code of ['download_failed','permission_denied']){
  const f=await fixture(t);let calls=0;const get=f.service.downloader.get.bind(f.service.downloader);
  f.service.downloader.get=async(...args)=>{calls++;if(calls===1)throw new XhsError(code);return get(...args);};
  const list=await executeXhsOperation('list_images',{ref_id:url},owner,{service:f.service});const job=await executeXhsOperation('download_images',{image_ids:[list.data.images[0].image_id]},owner,{service:f.service});await f.service.runPending();
  const s=await executeXhsOperation('job_status',{job_id:job.data.job_id},owner,{service:f.service});assert.equal(calls,code==='download_failed'?2:1);assert.equal(s.data.state,code==='download_failed'?'succeeded':'failed');
 }
});

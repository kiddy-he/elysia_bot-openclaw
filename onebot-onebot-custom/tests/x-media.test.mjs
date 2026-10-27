import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {normalizePost,parseXPostUrl,mediaUrl,validateX,XProvider,fromFx,fromSyndication} from '../src/src/features/x-provider.js';
import {executeXOperation} from '../src/src/features/x.js';
import {loadFeatureConfig} from '../src/src/feature-policy.js';
import {DeliveryQueue,authorizeDelivery} from '../src/src/delivery/queue.js';
import {OperationStore} from '../src/src/access/operations.js';
import {executeBusinessTool,registerBusinessTools} from '../src/src/features/tools.js';
import {bindFeatureTurn,decideFeatureTool} from '../src/src/feature-tools.js';
import {parseTurnIntent,failedTurnIntent,TURN_INTENT_RULES} from '../src/src/turn-intent.js';
import {validateXProxy,createXDownloader} from '../src/src/features/x-network.js';
const policy=loadFeatureConfig();
const context={accountId:'default',scope:'private',senderId:'700000003',requestId:'test-x',sessionKey:'test-x',explicit:true,roleCount:1,xOperation:true};
const post=(id,types=['image','image'],likes=10)=>normalizePost({id:String(id),text:`测试帖子${id}`,likes,author:{name:'博主',username:'author'},media:types.map((type,i)=>({type,url:type==='image'?`https://pbs.twimg.com/media/${id}-${i}.jpg`:`https://video.twimg.com/ext_tw_video/${id}-${i}.mp4`}))});
async function setup(t,posts=[post(20),post(21)]){
 const dir=await mkdtemp(join(tmpdir(),'onebot-x-test-'));const store=new OperationStore(join(dir,'operations.sqlite'));const sent=[];let downloaded=0;const png=await sharp({create:{width:2,height:2,channels:3,background:'red'}}).png().toBuffer();
 t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
 const queue=new DeliveryQueue({store,policy:()=>policy,config:async()=>({}),send:async p=>{sent.push(p);return {status:'sent',receipt:{message_id:'qq-test'}};}});
 const provider={search:async()=>posts,inspect:async urls=>urls.map(url=>posts.find(p=>p.post_id===parseXPostUrl(url).id))};
 const downloader={get:async(_url,opts)=>{downloaded++;opts.signal?.throwIfAborted();opts.budget?.request();opts.budget?.charge(png.length);await writeFile(opts.output,png);return{bytes:png.length};}};
 const options={provider,downloader,queue,temporaryRoot:join(dir,'tmp'),policy:()=>policy};
 return {dir,store,sent,queue,provider,downloader,options,get downloaded(){return downloaded;}};
}
test('post URL and media CDN validation reject spoof hosts, paths, credentials and arbitrary downloads',()=>{
 for(const url of ['https://twitter.com/a/status/20/photo/2?s=20','https://x.com/i/web/status/20','https://x.com/i/status/20'])assert.equal(parseXPostUrl(url).url,'https://x.com/i/status/20');
 for(const url of ['http://x.com/a/status/20','https://x.com.evil/a/status/20','https://x.com@evil/a/status/20','https://x.com:444/a/status/20','file:///20','https://x.com/a','https://x.com/a/status/20/extra',' https://x.com/a/status/20','https://x.com/../a/status/20\\'])assert.throws(()=>parseXPostUrl(url));
 for(const url of ['http://pbs.twimg.com/media/a.jpg','https://pbs.twimg.com.evil/media/a.jpg','https://pbs.twimg.com/private/a.jpg','https://localhost/a.jpg','https://pbs.twimg.com@127.0.0.1/a.jpg'])assert.throws(()=>mediaUrl(url,'image'));
 assert.match(mediaUrl('https://pbs.twimg.com/media/a.jpg?name=small','image'),/name=orig/u);
 assert.throws(()=>mediaUrl('https://video.twimg.com/v.m3u8','video'));
 assert.throws(()=>validateX('media_workflow',{query:'a',ref_ids:['https://x.com/a/status/20']}));
 for(const arg of ['target','path','cookie','command','accountId'])assert.throws(()=>validateX('media_workflow',{query:'a',[arg]:'bad'}));
 assert.throws(()=>validateX('media_workflow',{ref_ids:['https://x.com/a/status/20','https://twitter.com/b/status/20']}));
});
test('public metadata verifies exact post id and retains mixed photos and video, never thumbnail-only',()=>{
 const fx={code:200,tweet:{id:'20',text:'mixed',author:{},media:{all:[{type:'photo',url:'https://pbs.twimg.com/media/a.jpg'},{type:'video',url:'https://video.twimg.com/vid/a.mp4'}]}}};
 assert.deepEqual(fromFx(fx,'20').media.map(m=>m.type),['image','video']);
 assert.throws(()=>fromFx(fx,'21'));assert.throws(()=>fromFx({...fx,tweet:{id:'20',media:{photos:[]}}},'20'));
 assert.throws(()=>fromSyndication({id_str:'20',photos:[{url:'https://pbs.twimg.com/media/a.jpg'}]},'20'));
 assert.throws(()=>normalizePost({id:'20',media:[{type:'video',url:'https://evil/a.mp4'}]}));
});
test('search ranks sampled candidates, downloads each full album and sends all selected posts once',async t=>{
 const f=await setup(t,[post(20,['image','image'],10),post(21,['image','image','image','image'],30),post(22,['image'],20)]);
 const result=await executeXOperation('media_workflow',{query:'爱莉西雅 cosplay',post_count:2,rank:'likes'},context,f.options);
 assert.equal(result.ok,true);assert.equal(result.data.delivery_status,'delivered');assert.deepEqual(result.data.posts.map(p=>p.post_id),['21','22']);assert.equal(result.data.media_count,5);assert.equal(f.downloaded,5);assert.equal(f.sent.length,1);
 const request=JSON.parse(f.store.db.prepare('SELECT request FROM deliveries').get().request);assert.deepEqual(request.parts[0].nodes.map(n=>n.media.length),[4,1]);assert.equal(request.parts[0].nodes[0].title,'测试帖子21');
 for(const m of request.parts[0].nodes.flatMap(n=>n.media))assert.equal((await readFile(m.path)).length>0,true);
 assert.deepEqual(await readdir(join(f.dir,'tmp')),[]);
 // Different tool args in the same inbound message must reuse the durable send.
 const again=await executeXOperation('media_workflow',{query:'换一种搜索词'},context,f.options);assert.equal(again.ok,true);assert.equal(again.data.reused,true);assert.equal(f.sent.length,1);assert.equal(f.downloaded,5);
});
test('link extraction keeps every media item including mixed native video in one post node',async t=>{
 const f=await setup(t,[post(20,['image','video','image'])]);
 const result=await executeXOperation('media_workflow',{ref_ids:['https://twitter.com/user/status/20/video/1'],media_type:'video'},context,{...f.options,validateMedia:async()=>{}});
 assert.equal(result.ok,true);const request=JSON.parse(f.store.db.prepare('SELECT request FROM deliveries').get().request);assert.deepEqual(request.parts[0].nodes[0].media.map(m=>m.type),['image','video','image']);
});
test('partial download is settled and cleaned up before returning, no incomplete forward is sent',async t=>{
 const f=await setup(t);let calls=0;
 const result=await executeXOperation('media_workflow',{query:'test'},context,{...f.options,downloader:{get:async(url,opts)=>{if(++calls===2)throw Object.assign(new Error('secret response body'),{code:'download_failed'});return f.downloader.get(url,opts);}}});
 assert.equal(result.ok,false);assert.equal(result.error.code,'download_failed');assert.equal(f.sent.length,0);assert.deepEqual(await readdir(join(f.dir,'tmp')),[]);assert.equal(JSON.stringify(result).includes('secret response body'),false);
});
test('invalid decoded media cannot be forwarded even if HTTP succeeded',async t=>{
 const f=await setup(t,[post(20,['image'])]);const result=await executeXOperation('media_workflow',{query:'test'},context,{...f.options,downloader:{get:async(_u,opts)=>writeFile(opts.output,'not an image')}});
 assert.equal(result.ok,false);assert.equal(result.error.code,'invalid_image');assert.equal(f.sent.length,0);
});
test('missing authentication, upstream challenge, no media and uncertain send never claim success',async t=>{
 for(const code of ['auth_required','session_invalid','rate_limited','challenge_required']){
  const f=await setup(t);f.provider.search=async()=>{throw Object.assign(new Error('private upstream error'),{code});};const result=await executeXOperation('media_workflow',{query:'test'},context,f.options);assert.equal(result.error.code,code);assert.equal(f.sent.length,0);assert.equal(f.downloaded,0);
 }
 const f=await setup(t,[post(20,[])]);const r=await executeXOperation('media_workflow',{ref_ids:['https://x.com/a/status/20']},context,f.options);assert.equal(r.error.code,'no_media');assert.equal(f.sent.length,0);
 const q=await setup(t);q.queue.send=async()=>{throw new Error('possibly sent');};const first=await executeXOperation('media_workflow',{query:'test'},context,q.options);assert.equal(first.ok,false);assert.equal(first.data.delivery_status,'uncertain');const before=q.downloaded;const second=await executeXOperation('media_workflow',{query:'other'},context,q.options);assert.equal(second.data.delivery_status,'uncertain');assert.equal(q.downloaded,before);
});
test('concurrent duplicate calls share one operation; separate users progress independently',async t=>{
 const f=await setup(t);let release,started;const gate=new Promise(r=>release=r),entered=new Promise(r=>started=r);let calls=0;
 f.provider.search=async()=>{calls++;started();await gate;return [post(20)];};
 const first=executeXOperation('media_workflow',{query:'first'},context,f.options);await entered;
 const duplicate=executeXOperation('media_workflow',{query:'second'},context,f.options);
 const other=await executeXOperation('media_workflow',{ref_ids:['https://x.com/a/status/20']},{...context,senderId:'188888888',sessionKey:'other'},f.options);assert.equal(other.ok,true);assert.equal(calls,1);release();
 assert.equal((await first).ok,true);assert.equal((await duplicate).ok,true);assert.equal(f.sent.length,2);
});
test('all configured account/identity/scope combinations can use X; destinations bind to real request',async t=>{
 const factories=new Map();registerBusinessTools({registerTool:(fn,{names})=>factories.set(names[0],fn),on:()=>{}});
 for(const accountId of ['default','yuexia'])for(const senderId of ['700000003','188888888'])for(const scope of ['private','group']){
  const f=await setup(t,[post(20,['image'])]);const c={...context,accountId,senderId,scope,groupId:'700000011',sessionKey:`x:${accountId}:${senderId}:${scope}`};
  const release=bindFeatureTurn(c.sessionKey,c);try{assert.ok(factories.get('x_media_workflow')({sessionKey:c.sessionKey}));}finally{release();}
  const r=await executeXOperation('media_workflow',{ref_ids:['https://x.com/a/status/20']},c,f.options);assert.equal(r.ok,true);assert.equal(f.sent[0].to,`${scope}:${scope==='group'?c.groupId:c.senderId}`);
 }
 assert.equal(factories.get('x_media_workflow')({sessionKey:'unbound'}),null);
 assert.equal(decideFeatureTool(policy,'exec',{command:'curl https://x.com'},context).allowed,false);assert.equal(decideFeatureTool(policy,'xhs_search_posts',{},context).allowed,false);
 const f=await setup(t);await assert.rejects(executeXOperation('media_workflow',{query:'a'},{...context,scope:'group',groupId:'999999999'},f.options));
 const request={feature:'x',action:'media',accountId:'default',context,target:{type:'private',id:'199999999'},parts:[{type:'forward',nodes:[{title:'a',media:[{type:'image',path:'test'}]}]}]};assert.throws(()=>authorizeDelivery(request,policy));
});
test('revoking permissions or cancellation during download stops the final send',async t=>{
 for(const mode of ['revocation','cancel']){
  const f=await setup(t,[post(20,['image'])]),controller=new AbortController(),p=structuredClone(policy);let called=false;
  const r=await executeXOperation('media_workflow',{query:'a'},context,{...f.options,signal:controller.signal,policy:()=>p,downloader:{get:async(u,opts)=>{await f.downloader.get(u,opts);called=true;if(mode==='revocation')p.features.x.enabled=false;else controller.abort();}}});
  assert.equal(called,true);assert.equal(r.ok,false);assert.equal(f.sent.length,0);assert.equal(r.error.code,mode==='revocation'?'authorization_revoked':'cancelled');
 }
});
test('X intent comes only from model classification, with no local keyword fallback',()=>{
 const base={need_web_search:false,image_generation:false,official_reference:false,backend_operation:false};assert.equal(parseTurnIntent(JSON.stringify({...base,x_operation:true})).xOperation,true);assert.equal(parseTurnIntent(JSON.stringify(base)).xOperation,false);assert.equal(parseTurnIntent(JSON.stringify({...base,x_operation:'true'})).xOperation,false);assert.equal(failedTurnIntent('x.com').xOperation,false);assert.match(TURN_INTENT_RULES,/x_operation/u);
});
test('business executor persists one result for duplicate incoming tool calls and never launches shell',async t=>{
 const f=await setup(t);let count=0;const args={name:'x_media_workflow',params:{query:'cosplay'},context,sessionKey:context.sessionKey,callId:'first',store:f.store,getDeliveryQueue:()=>f.queue,xExecute:async()=>{count++;return{ok:true,data:{delivery_status:'delivered',receipt:{message_id:'qq'}}};},run:()=>assert.fail('must not launch subprocess')};
 assert.equal((await executeBusinessTool(args)).isError,false);await executeBusinessTool({...args,callId:'second'});assert.equal(count,1);
});
test('proxy supports only trusted local HTTP CONNECT endpoints, never tool-supplied settings',()=>{
 assert.equal(validateXProxy('http://127.0.0.1:7890').port,'7890');
 for(const p of ['http://evil:7890','https://127.0.0.1:7890','http://a:b@127.0.0.1:7890','http://127.0.0.1:7890/path'])assert.throws(()=>validateXProxy(p));
 assert.ok(createXDownloader());
});
test('cancelling an X forward waiting in its outbound lane prevents any later platform send',async t=>{
 const f=await setup(t,[post(20,['image'])]);let release,started;const gate=new Promise(r=>release=r),entered=new Promise(r=>started=r);let calls=0;
 f.queue.send=async()=>{calls++;started();await gate;return{status:'sent',receipt:{message_id:'first'}};};
 const image=join(f.dir,'block.png');await writeFile(image,await sharp({create:{width:2,height:2,channels:3,background:'red'}}).png().toBuffer());
 const initial=f.queue.enqueue({feature:'conversation',action:'chat',accountId:'default',target:{type:'private',id:context.senderId},context,parts:[{type:'image',path:image}]});await entered;
 const c=new AbortController();const pending=executeXOperation('media_workflow',{query:'a'},context,{...f.options,signal:c.signal});
 // Wait for the durable X record to enter the lane; no platform call is made yet.
 for(let i=0;i<100;i++){if(f.store.db.prepare("SELECT id FROM deliveries WHERE json_extract(request,'$.feature')='x'").get())break;await new Promise(r=>setTimeout(r,2));}
 assert.ok(f.store.db.prepare("SELECT id FROM deliveries WHERE json_extract(request,'$.feature')='x'").get());c.abort();release();await initial;
 const result=await pending;assert.equal(result.ok,false);assert.equal(result.data.delivery_status,'cancelled');assert.equal(calls,1);
});
test('media workflow respects the independent read action and returns uncertain progress honestly',async t=>{
 const f=await setup(t),p=structuredClone(policy);p.features.x.actions.read.enabled=false;
 const r=await executeXOperation('media_workflow',{query:'test'},context,{...f.options,policy:()=>p});assert.equal(r.error.code,'authorization_revoked');assert.equal(f.downloaded,0);
 const {toolProgressState}=await import('../src/src/task-progress.js');
 for(const [delivery_status,expected] of [['native_pending','uncertain'],['uncertain','uncertain'],['cancelled','failed'],['delivered','completed']])assert.equal(toolProgressState({toolName:'x_media_workflow',result:{details:{status:'failed',x:{ok:false,data:{delivery_status,receipt:delivery_status==='delivered'?{}:undefined}}}}}),expected);
});

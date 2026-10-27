import test from 'node:test';
import assert from 'node:assert/strict';
import {runXhsMediaWorkflow,validateXhsWorkflow} from '../src/src/features/xhs-workflow.js';
const posts=[1,2,3,4].map(n=>({post_id:String(n),source_url:`observed-${n}`,note_type:'normal',status:'ok',title:`帖子${n}`,metrics:{likes:n===4?null:{value:n*10}}}));
function executor(overrides={}) {
 const calls=[];
 const execute=async(op,input)=>{
  calls.push({op,input});
  if(overrides[op])return overrides[op](input);
  const data=op==='search'?{posts}:op==='inspect'?{resources:input.ref_ids.map(ref=>posts.find(p=>p.source_url===ref))}:
   op==='list_images'?{images:[{image_id:input.ref_id}]}:op==='download_images'?{job_id:'job'}:
   op==='job_status'?{state:'succeeded',result:{artifacts:posts.map(p=>({artifact_id:`art-${p.post_id}`,post:p})),failures:[]}}:
   op==='send_media'?{delivery_status:'delivered',receipt:{message_id:123},media_count:12}:{};
  return {ok:true,data};
 };return {execute,calls};
}
test('batch workflow ranks visible likes, inspects once and sends one complete batch without model round trips',async()=>{
 const e=executor(),r=await runXhsMediaWorkflow({query:'爱莉希雅 cos',rank:'likes'},{execute:e.execute});
 assert.equal(r.ok,true);assert.deepEqual(r.data.posts.map(p=>p.post_id),['3','2','1']);
 assert.equal(e.calls.filter(c=>c.op==='send_media').length,1);
 assert.deepEqual(e.calls.find(c=>c.op==='download_images').input.image_ids,['observed-3','observed-2','observed-1']);
 assert.equal(e.calls.find(c=>c.op==='search').input.limit,12);
});
test('explicit post workflow never searches or silently omits a selected post',async()=>{
 const e=executor({inspect:async()=>({ok:true,data:{partial:true,resources:[posts[0],{status:'failed',error:{code:'not_found'}}]}})});
 const r=await runXhsMediaWorkflow({ref_ids:['observed-1','observed-2']},{execute:e.execute});
 assert.equal(r.error.code,'selected_posts_incomplete');assert.deepEqual(e.calls.map(c=>c.op),['inspect']);
});
test('nested 461 stops the batch immediately without downloading or sending successful partial resources',async()=>{
 const e=executor({inspect:async()=>({ok:true,data:{resources:[posts[0],{status:'failed',error:{code:'challenge_required'}}]}})});
 const r=await runXhsMediaWorkflow({query:'cos'},{execute:e.execute});
 assert.equal(r.error.code,'challenge_required');assert.deepEqual(e.calls.map(c=>c.op),['search','inspect']);
});
test('partial download never stages or sends an incomplete batch; uncertain send never becomes delivered',async()=>{
 for(const state of ['partial','failed','cancelled']){
  const e=executor({job_status:async()=>({ok:true,data:{state,result:{artifacts:[{artifact_id:'art-1',post:posts[0]}]}}})});
  const r=await runXhsMediaWorkflow({query:'cos'},{execute:e.execute});
  assert.equal(r.ok,false);assert(!e.calls.some(c=>c.op==='artifact'||c.op==='send_media'));
 }
 const e=executor({send_media:async()=>({ok:true,data:{delivery_status:'uncertain'}})});
 const r=await runXhsMediaWorkflow({ref_ids:['observed-1']},{execute:e.execute});
 assert.equal(r.ok,false);assert.equal(r.error.code,'delivery_unconfirmed');assert.equal(e.calls.filter(c=>c.op==='send_media').length,1);
});
test('bounded caller deadline cancels polling and no send occurs',async()=>{
 const controller=new AbortController();
 const e=executor({job_status:async()=>({ok:true,data:{state:'running'}})});
 const r=await runXhsMediaWorkflow({ref_ids:['observed-1']},{execute:e.execute,signal:controller.signal,wait:async()=>controller.abort()});
 assert.equal(r.error.code,'workflow_cancelled');assert(!e.calls.some(c=>c.op==='send_media'));
});
test('video workflows preserve post identities and collect every selected video into one send',async()=>{
 const selected=posts.slice(0,2).map(p=>({...p,note_type:'video'}));let job=0;
 const e=executor({inspect:async()=>({ok:true,data:{resources:selected}}),download_video:async()=>({ok:true,data:{job_id:`job-${++job}`}}),
  job_status:async({job_id})=>({ok:true,data:{state:'succeeded',result:{artifacts:[{artifact_id:job_id,post:selected[Number(job_id.slice(-1))-1]}]}}})});
 const r=await runXhsMediaWorkflow({ref_ids:['observed-1','observed-2'],media_type:'video'},{execute:e.execute});
 assert(r.ok);assert.equal(job,2);assert.equal(e.calls.filter(c=>c.op==='send_media').length,1);assert(!e.calls.some(c=>c.op==='list_images'));
});
test('workflow schema rejects ambiguous sources, oversized batches and arbitrary routing or constraints',()=>{
 for(const params of [{},{query:'x',ref_ids:['y']},{query:'x',post_count:4},{ref_ids:['x'],target:'other'},{query:'x',rank:'global-most-liked'},{ref_ids:['x','x']}]) assert.throws(()=>validateXhsWorkflow(params));
});

 test('recent posts are avoided when enough fresh candidates exist; explicit links are always respected',async()=>{
 const e=executor();const r=await runXhsMediaWorkflow({query:'cos',post_count:2,rank:'likes'},{execute:e.execute,recentPostIds:['3','2']});
 assert.equal(r.ok,true);assert.deepEqual(r.data.posts.map(p=>p.post_id),['1','4']);
 const x=executor();const explicit=await runXhsMediaWorkflow({ref_ids:['observed-3']},{execute:x.execute,recentPostIds:['3']});assert.equal(explicit.data.posts[0].post_id,'3');
});

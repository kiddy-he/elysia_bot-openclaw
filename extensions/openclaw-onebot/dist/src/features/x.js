import { notifyMediaSelected } from '../media-completion.js';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { onebotPath } from '../paths.js';
import { deliveryQueue } from '../delivery/queue.js';
import { loadFeatureConfig, authorizeFeature } from '../feature-policy.js';
import { createXDownloader } from './x-network.js';
import { validateImage, validateVideo } from '../xhs/infra/media.js';
import { XProvider, validateX, publicXPost, xFail, xError, mediaUrl } from './x-provider.js';

const turns = new Map();
function authorize(context, action, policy) {
  if(!context?.requestId || context.internal || context.actorType==='service' || !context.sessionKey || !['private','group'].includes(context.scope) || !authorizeFeature(policy(),'x',action,context).allowed) xFail('authorization_revoked');
}
const result = (operation,ok,data,error=null) => ({version:1,operation,ok,status:ok?'ok':'failed',data,error});
export async function executeXOperation(operation,input,context,{signal,operationId,provider,queue,downloader,policy=loadFeatureConfig,validateMedia,temporaryRoot=onebotPath('state/x-media/tmp'),now=Date.now,onStage=()=>{}}={}) {
  input=validateX(operation,input);
  authorize(context,operation==='media_workflow'?'media':'read',policy);
  signal?.throwIfAborted();
  provider??=new XProvider();
  if(operation!=='media_workflow') {
    try {
      const posts=operation==='search'?await provider.search(input,{signal}):await provider.inspect(input.ref_ids,{signal});
      signal?.throwIfAborted();authorize(context,'read',policy);
      return result(operation,true,{posts:posts.map(publicXPost)});
    }catch(e){return result(operation,false,{}, {code:xError(e,signal)});}
  }
  const peer=[context.accountId,context.scope,context.scope==='group'?context.groupId:context.senderId,context.senderId].join(':'),key=`x-forward:${peer}:${context.requestId}`;
  // Two model calls in one turn share the same host operation, including calls
  // with reworded queries. Other users and other turns continue independently.
  if(turns.has(key)) return turns.get(key);
  const work=runWorkflow(input,context,{signal,operationId,provider,queue:queue??deliveryQueue(),downloader:downloader??provider.downloader??createXDownloader(),policy,validateMedia,temporaryRoot,now,onStage,key});
  turns.set(key,work);
  try {return await work;} finally {if(turns.get(key)===work) turns.delete(key);}
}
async function runWorkflow(input,context,{signal,operationId,provider,queue,downloader,policy,validateMedia,temporaryRoot,now,onStage,key}) {
  const started=now(),timings=[];let directory,posts=[],mediaCount=0;
  const stage=async(name,work)=>{signal?.throwIfAborted();authorize(context,'media',policy);if(['search','inspect'].includes(name))authorize(context,'read',policy);const start=now();try{return await work();}finally{const t={stage:name,elapsed_ms:now()-start};timings.push(t);onStage(t);}};
  try {
    // Read the durable receipt before doing network work. Uncertain deliveries
    // are reported as uncertain; they must never produce a second forward.
    const prior=queue.store?.db.prepare('SELECT id,state,receipt FROM deliveries WHERE dedupe=?').get(key);
    if(prior) return receiptResult(prior.state,prior.id,prior.receipt?JSON.parse(prior.receipt):undefined,{reused:true,timings,elapsed_ms:now()-started});
    const rank=input.rank??'relevance',kind=input.media_type??'auto';let candidateCount;
    if(input.query) {
      const candidates=await stage('search',()=>provider.search({query:input.query,limit:20,rank,media_type:kind},{signal}));
      candidateCount=candidates.length;
      const eligible=[...new Map(candidates.filter(p=>p.media.length && (kind==='auto'||p.media.some(m=>m.type===kind))).map(p=>[p.post_id,p])).values()];
      if(rank==='likes') eligible.sort((a,b)=>b.metrics.likes-a.metrics.likes);
      posts=eligible.slice(0,input.post_count??3);
      if(!posts.length) xFail('no_matching_posts');
      // Search returns full structured media. Re-inspect only selected posts to
      // verify the full album and avoid sending stale/incomplete search cards.
      posts=await stage('inspect',()=>provider.inspect(posts.map(p=>p.source_url),{signal}));
    } else posts=await stage('inspect',()=>provider.inspect(input.ref_ids,{signal}));
    if(!posts.length || input.ref_ids && posts.length!==input.ref_ids.length || new Set(posts.map(p=>p.post_id)).size!==posts.length) xFail('album_incomplete');
    if(posts.some(p=>!p.media.length || kind!=='auto'&&!p.media.some(m=>m.type===kind))) xFail('no_media');
    // media_type filters posts, not album items: mixed posts retain all media.
    notifyMediaSelected(context,'x',posts);
    mediaCount=posts.reduce((n,p)=>n+p.media.length,0);
    if(mediaCount>48) xFail('too_many_media');
    await mkdir(temporaryRoot,{recursive:true,mode:0o700});directory=await mkdtemp(join(temporaryRoot,'turn-'));
    const nodes=posts.map(p=>({title:p.title,media:new Array(p.media.length)})),tasks=[];
    posts.forEach((p,i)=>p.media.forEach((m,j)=>tasks.push({i,j,media:m})));
    let requests=0,bytes=0,next=0;
    const budget={request(){if(++requests>160)xFail('budget_exceeded');},charge(n){bytes+=n;if(bytes>100*1024*1024)xFail('budget_exceeded');}};
    const controller=new AbortController(),downloadSignal=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    await stage('download',async()=>{
      const workers=Array.from({length:Math.min(3,tasks.length)},async()=>{
        while(next<tasks.length){
          const {i,j,media:m}=tasks[next++];downloadSignal.throwIfAborted();
          const path=join(directory,`${i}-${j}.${m.type==='image'?'jpg':'mp4'}`),url=mediaUrl(m.url,m.type);
          await downloader.get(url,{output:path,signal:downloadSignal,maxBytes:(m.type==='image'?8:25)*1024*1024,timeoutMs:45000,referer:posts[i].source_url,budget,follow:u=>{try{return mediaUrl(u.href,m.type)===u.href;}catch{return false;}}});
          if(validateMedia) await validateMedia(path,m.type,downloadSignal);
          else if(m.type==='image') await validateImage(path,downloadSignal);else await validateVideo(path,downloadSignal);
          nodes[i].media[j]={type:m.type,path};
        }
      });
      // Settle every worker before cleanup: a rejected download must not leave
      // another worker writing into a removed temporary directory.
      let first;await Promise.all(workers.map(p=>p.catch(e=>{first??=e;controller.abort(e);})));if(first) throw first;
    });
    if(nodes.some(n=>n.media.some(m=>!m))) xFail('album_incomplete');
    const delivery=await stage('send',()=>queue.enqueue({feature:'x',action:'media',accountId:context.accountId,target:{type:context.scope,id:String(context.scope==='group'?context.groupId:context.senderId)},context:{senderId:context.senderId,accountId:context.accountId,scope:context.scope,groupId:context.groupId,explicit:context.explicit,roleCount:context.roleCount,requestId:context.requestId,mediaCompletionFast:context.mediaCompletionFast===true},expiresAt:started+180000,sessionKey:context.sessionKey,workspaceAgentId:context.workspaceAgentId,parts:[{type:'forward',nodes}],operationId,dedupeKey:key},{signal}));
    return receiptResult(delivery.state,delivery.id,delivery.receipt,{posts:posts.map(publicXPost),media_count:mediaCount,candidate_count:candidateCount,rank,timings,elapsed_ms:now()-started});
  }catch(e){return result('media_workflow',false,{delivery_status:'not_confirmed',timings,elapsed_ms:now()-started},{code:xError(e,signal)});}
  finally {if(directory) await rm(directory,{recursive:true,force:true});}
}
function receiptResult(state,id,receipt,data) {
  const ok=state==='accepted'&&Boolean(receipt);
  return result('media_workflow',ok,{...data,delivery_status:ok?'delivered':state,delivery_id:id,...(ok?{receipt}:{})},ok?null:{code:'delivery_unconfirmed'});
}

import Ajv from 'ajv';
import { setTimeout as delay } from 'node:timers/promises';

export const xhsWorkflowSchema = {
  type:'object',additionalProperties:false,
  properties:{query:{type:'string',minLength:1,maxLength:120},ref_ids:{type:'array',minItems:1,maxItems:3,uniqueItems:true,items:{type:'string',minLength:1,maxLength:2000}},
    post_count:{type:'integer',minimum:1,maximum:3},media_type:{enum:['image','video']},rank:{enum:['likes','relevance','latest']}},
  oneOf:[{required:['query'],not:{required:['ref_ids']}},{required:['ref_ids'],not:{required:['query']}}],
};
const validate=new Ajv({strict:false}).compile(xhsWorkflowSchema);
export function validateXhsWorkflow(params) {
  if(!validate(params)) throw new Error('invalid_request');
  return structuredClone(params);
}
const stopCodes=new Set(['challenge_required','manual_verification_pending','login_required','session_invalid','rate_limited','permission_denied','network_restricted','authorization_revoked','authorization_expired']);
const failure=code=>Object.assign(new Error(code),{code});
// The model chooses the request once; the host owns all deterministic steps.
// execute() retains the existing resource owner, authorization and challenge checks.
export async function runXhsMediaWorkflow(params,{execute,signal,wait=ms=>delay(ms,undefined,{signal}),now=Date.now,onStep=()=>{},onSelected=()=>{},recentPostIds=[]}) {
  params=validateXhsWorkflow(params);
  const started=now(),timings=[],jobs=[];
  const step=async(operation,input)=>{
    signal?.throwIfAborted();
    const start=now();
    const result=await execute(operation,input);
    const elapsedMs=now()-start;
    const previous=timings.at(-1);if(operation==='job_status'&&previous?.operation===operation){previous.elapsedMs+=elapsedMs;previous.polls=(previous.polls??1)+1;}else timings.push({operation,elapsedMs});
    onStep(operation,result);
    const resources=result.data?.resources??[];
    const blocked=resources.find(r=>stopCodes.has(r.error?.code));
    if(!result.ok || blocked) throw failure(blocked?.error.code??result.error?.code??'workflow_step_failed');
    return result.data;
  };
  try {
    const kind=params.media_type??'image',count=params.post_count??3,rank=params.rank??'relevance';
    let sources=params.ref_ids;
    let candidateCount;
    let searchedPosts=[];
    if(!sources){
      const search=await step('search',{query:params.query,limit:12,media_type:kind,sort:rank==='latest'?'latest':'relevance'});
      const posts=[...new Map((search.posts??[]).filter(p=>p.source_url).map(p=>[p.post_id,p])).values()];
      candidateCount=posts.length;
      const recent=new Set(recentPostIds);
      if(rank==='likes') posts.sort((a,b)=>(b.metrics?.likes?.value??-1)-(a.metrics?.likes?.value??-1));
      const fresh=posts.filter(p=>!recent.has(p.post_id)),repeated=posts.filter(p=>recent.has(p.post_id));
      searchedPosts=posts;sources=[...fresh,...repeated].slice(0,count).map(p=>p.source_url);
    }
    if(!sources.length) throw failure('no_matching_posts');
    const inspected=await step('inspect',{ref_ids:sources});
    const posts=(inspected.resources??[]).filter(p=>p.status==='ok' && p.note_type===(kind==='image'?'normal':'video')).map(p=>({...p,title:p.title||searchedPosts.find(s=>s.post_id===p.post_id)?.title||'小红书帖子'}));
    // Explicit selections must never silently omit a failed or wrong-kind post.
    if(posts.length!==sources.length) throw failure('selected_posts_incomplete');
    if(rank==='likes') posts.sort((a,b)=>(b.metrics?.likes?.value??-1)-(a.metrics?.likes?.value??-1));
    onSelected(posts);
    if(kind==='image'){
      const handles=[];
      for(const post of posts){
        const images=await step('list_images',{ref_id:post.source_url});
        if(!images.images?.length || images.candidate_limit_reached) throw failure('album_incomplete');
        handles.push(images.images[0].image_id);
      }
      const job=await step('download_images',{image_ids:handles});jobs.push(job.job_id);
    }else for(const post of posts){const job=await step('download_video',{ref_id:post.source_url});jobs.push(job.job_id);}
    const artifacts=[];
    for(const job_id of jobs){
      let status=await step('job_status',{job_id});
      while(['queued','running'].includes(status.state)){
        await wait(250);status=await step('job_status',{job_id});
      }
      if(status.state!=='succeeded' || status.result?.failures?.length) throw failure(status.error?.code??'download_incomplete');
      artifacts.push(...(status.result?.artifacts??[]));
    }
    const byPost=new Map(artifacts.map(a=>[a.post?.post_id,a]));
    if(posts.some(p=>!byPost.has(p.post_id))) throw failure('album_incomplete');
    for(const post of posts) await step('artifact',{artifact_id:byPost.get(post.post_id).artifact_id});
    const sent=await step('send_media',{});
    return {version:1,operation:'media_workflow',ok:sent.delivery_status==='delivered'&&Boolean(sent.receipt),status:sent.delivery_status==='delivered'&&sent.receipt?'ok':'failed',
      data:{...sent,posts:posts.map(p=>({post_id:p.post_id,title:p.title,source_url:p.source_url,author:p.author,metrics:p.metrics})),candidate_count:candidateCount,rank,job_ids:jobs,timings,elapsed_ms:now()-started},error:sent.delivery_status==='delivered'&&sent.receipt?null:{code:'delivery_unconfirmed'}};
  }catch(error){
    return {version:1,operation:'media_workflow',ok:false,status:'failed',data:{delivery_status:'not_confirmed',job_ids:jobs,timings,elapsed_ms:now()-started},
      error:{code:signal?.aborted?'workflow_cancelled':error.code??'workflow_failed'}};
  }
}

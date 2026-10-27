import { ReachXhsBackend } from '../xhs/backends/reach.js';
import { notifyMediaSelected } from '../media-completion.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { XhsService } from '../xhs/index.js';
import { onebotPath } from '../paths.js';
import { deliveryQueue } from '../delivery/queue.js';
import { requestXhsVerification, xhsVerificationPending } from './xhs-verification.js';
import {smsRecoveryEnabled,xhsSmsPending,observeXhsChallenge} from './xhs-sms.js';
import {isRecoverableAuth} from './xhs-sms-recovery.js';
import { runXhsMediaWorkflow } from './xhs-workflow.js';
import { loadFeatureConfig, authorizeFeature } from '../feature-policy.js';

const CONFIG_PATH = onebotPath('onebot-xhs.json');
let singleton, starting;
const mediaOperations = new Set(['artifact', 'download_images', 'download_video', 'job_status', 'cancel_job','send_media']);
function config() {
  const value = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  if (value.version !== 1 || value.enabled !== true || typeof value.dataDir !== 'string' || !value.dataDir.trim() || !['http','agent-reach'].includes(value.backend ?? 'http')) throw new Error('小红书业务未启用或配置无效');
  for (const [key, min, max] of [['requestTimeoutMs',1000,90000],['jobTimeoutMs',1000,300000],['jobConcurrency',1,2]]) {
    if (value[key] !== undefined && (!Number.isInteger(value[key]) || value[key] < min || value[key] > max)) throw new Error(`小红书配置无效：${key}`);
  }
  return value;
}
const contentOperations = new Set(['search','inspect','comments','profile','list_images',...mediaOperations]);
export function xhsPeer(context) {
  return context.scope === 'group'
    ? `onebot:${context.accountId}:group:${context.groupId}:${context.senderId}`
    : `onebot:${context.accountId}:private:${context.senderId}`;
}
export function xhsToolContext(context, policy = loadFeatureConfig()) {
  return Boolean(context?.requestId && !context.internal && context.actorType !== 'service'
    && /^[1-9][0-9]{4,19}$/u.test(String(context.senderId))
    && ['read','media'].some(action=>authorizeFeature(policy,'xiaohongshu',action,context).allowed));
}
export function authorizeXhs(origin, operation, policy = loadFeatureConfig()) {
  if (!contentOperations.has(operation)) return false;
  const match = /^onebot:([^:]+):(private|group):([0-9]+)(?::([0-9]+))?$/u.exec(origin?.scope ?? '');
  if (!match || (match[2]==='private' ? match[4] || match[3]!==String(origin.actorId) : match[4]!==String(origin.actorId))) return false;
  return authorizeFeature(policy, 'xiaohongshu', mediaOperations.has(operation) ? 'media' : 'read',
    {accountId:match[1],scope:match[2],senderId:origin.actorId,...(match[2]==='group'?{groupId:match[3]}:{})}).allowed;
}
export async function getXhsService() {
  if (singleton) return singleton;
  if (!starting) starting = (async () => {
    const cfg = config();
    const permitted = async (origin, operation) => { try { config(); return authorizeXhs(origin,operation); } catch { return false; } };
    const service = await XhsService.create({dataDir:resolve(cfg.dataDir),backend:cfg.backend==='agent-reach'?new ReachXhsBackend(): 'http',completeAlbums:true,maxSearches:4,maxVideoBytes:25*1024*1024,
      requestTimeoutMs:cfg.requestTimeoutMs ?? 85000,jobTimeoutMs:cfg.jobTimeoutMs ?? 180000,jobConcurrency:cfg.jobConcurrency ?? 2,
      authorize:permitted,authorizeJob:permitted});
    service.store.db.exec('CREATE TABLE IF NOT EXISTS onebot_request_owners (request TEXT PRIMARY KEY, origin TEXT NOT NULL, peer TEXT NOT NULL)');
    service.start({intervalMs:1000}); singleton=service; return service;
  })();
  try { return await starting; } finally { starting=undefined; }
}
export async function startXhsService() {
  try { const cfg=JSON.parse(readFileSync(CONFIG_PATH,'utf8')); if (cfg.enabled !== true || cfg.backend === 'agent-reach' && cfg.mediaEnabled!==true) return false; }
  catch(error) { if (error.code === 'ENOENT') return false; throw error; }
  await getXhsService(); return true;
}
export async function stopXhsService() {
  const service=singleton; singleton=undefined;
  if (service) await service.close();
}
export function resolveXhsContext(service, context, operation, params, cfg = config()) {
  if (!xhsToolContext(context)) throw new Error('当前用户或会话未获小红书功能授权');
  let origin={accountId:cfg.accountId ?? 'xhs-default',scope:xhsPeer(context),actorId:String(context.senderId),requestId:String(context.requestId)};
  const db=service.store.db;
  const handles=[];
  if (params.job_id) handles.push(['jobs',params.job_id]);
  if (params.artifact_id) handles.push(['artifacts',params.artifact_id]);
  if (params.cursor || params.posts_cursor) handles.push(['cursors',params.cursor || params.posts_cursor]);
  for (const id of params.image_ids ?? []) handles.push(['candidates',id]);
  let request;
  for (const [table,id] of handles) {
    const row=db.prepare(`SELECT request FROM ${table} WHERE id=?`).get(id);
    if (!row) throw new Error('小红书资源不存在或已过期');
    if (request && request !== row.request) throw new Error('不能混用不同请求的资源');
    request=row.request;
  }
  if (request) {
    const owner=db.prepare('SELECT origin,peer FROM onebot_request_owners WHERE request=?').get(request);
    if (!owner || owner.peer !== origin.scope || JSON.parse(owner.origin).actorId !== origin.actorId) throw new Error('小红书资源不属于当前用户和会话');
    origin=JSON.parse(owner.origin);
  }
  if (!authorizeXhs(origin,operation)) throw new Error('小红书权限已撤销');
  db.prepare('INSERT OR IGNORE INTO onebot_request_owners VALUES(?,?,?)').run(service.context(origin),JSON.stringify(origin),origin.scope);
  return origin;
}
// This adapter is shared by all live operation results. Dependencies are
// injectable so recovery dispatch can be verified without real SMS/QQ effects.
export async function observeXhsAuthResult(result, context, {smsEnabled=smsRecoveryEnabled,observe=observeXhsChallenge,verify=requestXhsVerification} = {}) {
  if (isRecoverableAuth(result)) {
    const recovery=smsEnabled()?await observe(result,context):null;
    return {...result,...(recovery?{sms_recovery:recovery}:{manual_verification:verify()})};
  }
  if (result.ok) await observe(result,context);
  return result;
}
export async function executeXhsOperation(operation, params, context, {callId,signal,operationId,service:providedService,queue:providedQueue,runStep,pollWaitMs=10000} = {}) {
  signal?.throwIfAborted();
  if(operation==='media_workflow') {
    const service=providedService ?? await getXhsService();ensureBatches(service);
    const peer=xhsPeer(context),turn=String(context.requestId);
    const before=new Set(service.store.db.prepare('SELECT artifact FROM onebot_media_selections WHERE peer=? AND turn=?').all(peer,turn).map(r=>r.artifact));
    service.store.db.exec('CREATE TABLE IF NOT EXISTS onebot_xhs_recent (peer TEXT NOT NULL, post_id TEXT NOT NULL, sent_at INTEGER NOT NULL, PRIMARY KEY(peer,post_id))');
    service.store.db.prepare('DELETE FROM onebot_xhs_recent WHERE sent_at<?').run(Date.now()-86400000);
    const recentPostIds=service.store.db.prepare('SELECT post_id FROM onebot_xhs_recent WHERE peer=? AND sent_at>?').all(peer,Date.now()-30*60000).map(r=>r.post_id);
    const result=await runXhsMediaWorkflow(params,{signal,recentPostIds,onSelected:posts=>notifyMediaSelected(context,'xiaohongshu',posts),execute:(op,input)=>{
      const task=()=>executeXhsOperation(op,input,context,{callId,signal,operationId,...(providedService?{service}:{}),queue:providedQueue,pollWaitMs:0});
      return runStep && op!=='send_media'?runStep(task):task();
    }});
    if(!result.ok && !service.store.db.prepare('SELECT sealed FROM onebot_media_batches WHERE peer=? AND turn=?').get(peer,turn)?.sealed) {
      for(const row of service.store.db.prepare('SELECT artifact FROM onebot_media_selections WHERE peer=? AND turn=?').all(peer,turn))
        if(!before.has(row.artifact)) service.store.db.prepare('DELETE FROM onebot_media_selections WHERE peer=? AND turn=? AND artifact=?').run(peer,turn,row.artifact);
    }
    if(result.ok&&result.data?.receipt)for(const post of result.data.posts??[])service.store.db.prepare('INSERT OR REPLACE INTO onebot_xhs_recent VALUES(?,?,?)').run(peer,post.post_id,Date.now());
    return result;
  }
  const service=providedService ?? await getXhsService();
  if (operation === 'send_media') return {version:1,operation,ok:true,status:'ok',data:await flushXhsMediaForTurn(context,{service,queue:providedQueue,operationId}),error:null};
  const origin=resolveXhsContext(service,context,operation,params);
  // Models sometimes pass a displayed note ID instead of its full observed URL.
  // Resolve only IDs already observed in this request; never guess access tokens.
  const observed=new Map();
  if (params.ref_id || params.ref_ids) for (const row of service.store.db.prepare('SELECT data FROM cache WHERE request=? AND expires>?').all(service.context(origin),Date.now())) {
    const cached=JSON.parse(row.data);for (const post of cached.posts ?? []) if (post.post_id && post.source_url) observed.set(post.post_id,post.source_url);
  }
  const ref=value=>observed.get(value) ?? value;
  const input={...params,...(params.ref_id ? {ref_id:ref(params.ref_id)} : {}),...(params.ref_ids ? {ref_ids:params.ref_ids.map(ref)} : {})};
  if (!providedService && ['search','inspect','comments','profile','list_images','download_images','download_video'].includes(operation) && (xhsVerificationPending() || xhsSmsPending())) {
    const pending={version:1,operation,ok:false,status:'failed',data:null,error:{code:'manual_verification_pending'},manual_verification:{status:'pending'}};
    if(xhsSmsPending()) await observeXhsChallenge({...pending,error:{code:'challenge_required',stopped_in_request:true}},{...context,xhsOriginRequestId:origin.requestId});
    return pending;
  }
  let result=await service.execute(operation,input,origin,{callId,signal});


  // Poll with a bounded wait so the model sees new states rather than tight loops.
  if (operation === 'job_status') {
    const deadline=Date.now()+pollWaitMs;
    while (result.ok && ['queued','running'].includes(result.data?.state) && Date.now()<deadline) {
      await delay(500,undefined,{signal});
      result=await service.execute(operation,params,origin,{callId,signal});
    }
  }
  if (!providedService) result=await observeXhsAuthResult(result,{...context,xhsOriginRequestId:origin.requestId});
  if (!result.ok || operation !== 'artifact' || !result.data?.path) return result;
  const source=result.data;
  if (source.bytes > 25*1024*1024) throw new Error('媒体已下载，但超过当前 QQ 附件投递的 25MiB 上限，未发送');
  ensureBatches(service);
  const peer=origin.scope, turn=String(context.requestId);
  if (service.store.db.prepare('SELECT sealed FROM onebot_media_batches WHERE peer=? AND turn=? AND sealed=1').get(peer,turn)) throw new Error('本轮媒体合并消息已提交，不再追加或重复发送');
  let selected=[source];
  if (source.kind === 'image') {
    if (!Number.isInteger(source.album_total) || source.album_total<1) throw new Error('此产物缺少完整图集信息，请重新下载该帖子全部图片');
    const byIndex=new Map();
    for (const row of service.store.db.prepare('SELECT id,data FROM artifacts WHERE request=? AND expires>? ORDER BY rowid').all(service.context(origin),Date.now())) {
      const item=JSON.parse(row.data);
      if (item.kind==='image' && item.post?.post_id===source.post?.post_id && item.album_total===source.album_total) byIndex.set(item.media_index,item);
    }
    if (byIndex.size!==source.album_total || Array.from({length:source.album_total},(_,i)=>i).some(i=>!byIndex.has(i))) throw new Error('该帖图片尚未全部下载成功，未发送残缺图集');
    selected=[...byIndex.values()];
  }
  const insert=service.store.db.prepare('INSERT OR IGNORE INTO onebot_media_selections(peer,turn,artifact,kind,path,created) VALUES(?,?,?,?,?,?)');
  for (const item of selected) insert.run(peer,turn,item.artifact_id,item.kind,'',Date.now());
  const {path:_path,...safe}=source;
  return {...result,data:{...safe,delivery_status:'staged_for_forward',staged_post_media_count:selected.length,next_step:'当前帖子全部图片已暂存（视频帖暂存视频）；选好其他帖子后调用xhs_send_media一次，按帖分节点合并发送；当前尚未发送。'}};
}
function ensureBatches(service) {
  service.store.db.exec(`CREATE TABLE IF NOT EXISTS onebot_media_selections(peer TEXT NOT NULL,turn TEXT NOT NULL,artifact TEXT NOT NULL,kind TEXT NOT NULL,path TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(peer,turn,artifact));
    CREATE TABLE IF NOT EXISTS onebot_media_batches(peer TEXT NOT NULL,turn TEXT NOT NULL,sealed INTEGER NOT NULL,delivery_id TEXT,PRIMARY KEY(peer,turn));`);
}
export async function flushXhsMediaForTurn(context,{service:providedService,queue:providedQueue,operationId}={}) {
  const service=providedService ?? await getXhsService();ensureBatches(service);
  if (!xhsToolContext(context)) throw new Error('当前用户或会话未获小红书功能授权');
  const peer=xhsPeer(context),turn=String(context.requestId);
  const selected=service.store.db.prepare('SELECT * FROM onebot_media_selections WHERE peer=? AND turn=? ORDER BY created,artifact').all(peer,turn);
  if (!selected.length) return {delivery_status:'nothing_staged',media_count:0};
  resolveXhsContext(service,context,'send_media',{});
  if (selected.length>160) throw new Error('本轮媒体超过160个，请减少帖子数量');
  const queue=providedQueue ?? deliveryQueue(),dedupeKey=`xhs-forward:${peer}:${turn}`;
  const prior=queue.store?.db.prepare('SELECT id,state,receipt FROM deliveries WHERE dedupe=?').get(dedupeKey);
  let delivery;
  if (prior) delivery={id:prior.id,state:prior.state,receipt:prior.receipt?JSON.parse(prior.receipt):undefined};
  else {
    service.store.db.prepare('INSERT OR REPLACE INTO onebot_media_batches VALUES(?,?,1,NULL)').run(peer,turn);
    const groups=new Map();
    for (const item of selected) {
      const origin=resolveXhsContext(service,context,'artifact',{artifact_id:item.artifact});
      const verified=await service.execute('artifact',{artifact_id:item.artifact},origin);
      if (!verified.ok) throw new Error(`小红书媒体不可用：${verified.error?.code}`);
      if (!['image','video'].includes(verified.data.kind) || !verified.data.path) throw new Error('小红书媒体类型无效');
      const media=verified.data, postId=media.post?.post_id;
      if (!postId) throw new Error('小红书媒体缺少帖子归属');
      if (!groups.has(postId)) groups.set(postId,{kind:media.kind,total:media.album_total,title:typeof media.post?.title==='string' ? media.post.title : '',items:new Map()});
      const group=groups.get(postId);
      if (!group.title && typeof media.post?.title==='string') group.title=media.post.title;
      if (group.kind!==media.kind || group.total!==media.album_total) throw new Error('图集信息不一致');
      group.items.set(media.kind==='image'?media.media_index:0,{type:media.kind,path:media.path});
    }
    const nodes=[];
    for (const group of groups.values()) {
      if (group.kind==='image' && (!Number.isInteger(group.total) || group.items.size!==group.total || Array.from({length:group.total},(_,i)=>i).some(i=>!group.items.has(i)))) throw new Error('该帖图集不完整，未发送部分图片');
      nodes.push({title:group.title || '小红书帖子',media:[...group.items.entries()].sort(([a],[b])=>a-b).map(([,item])=>item)});
    }
    delivery=await queue.enqueue({feature:'xiaohongshu',action:'media',accountId:context.accountId,target:{type:context.scope,id:String(context.scope==='group'?context.groupId:context.senderId)},
      context:{senderId:context.senderId,accountId:context.accountId,scope:context.scope,groupId:context.groupId,explicit:context.explicit,roleCount:context.roleCount,requestId:context.requestId,mediaCompletionFast:context.mediaCompletionFast===true},
      sessionKey:context.sessionKey,workspaceAgentId:context.workspaceAgentId,parts:[{type:'forward',nodes}],operationId,dedupeKey});
    service.store.db.prepare('UPDATE onebot_media_batches SET delivery_id=? WHERE peer=? AND turn=?').run(delivery.id,peer,turn);
  }
  return {delivery_status:delivery.state==='accepted'?'delivered':delivery.state,delivery_id:delivery.id,media_count:selected.length,
    ...(delivery.state==='accepted'?{receipt:delivery.receipt}:{})};
}

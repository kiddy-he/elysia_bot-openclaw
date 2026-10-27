// Real provider/download tests; only the explicitly selected admin case sends QQ.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {ReachXhsBackend} from '../src/src/xhs/backends/reach.js';
import {XhsService} from '../src/src/xhs/service.js';
import {executeXhsOperation} from '../src/src/features/xhs.js';
import {OperationStore} from '../src/src/access/operations.js';
import {DeliveryQueue} from '../src/src/delivery/queue.js';
import {resolveOneBotAccount} from '../src/src/config.js';
import {sendForwardTransport} from '../src/src/outbound.js';
import {executeBusinessTool} from '../src/src/features/tools.js';
import {loadFeatureConfig} from '../src/src/feature-policy.js';
const root=process.argv[2];if(!root?.startsWith('/root/.openclaw/state/analysis/reach-xhs-'))throw Error('analysis root required');
await mkdir(root,{recursive:true,mode:0o700});
const real=process.argv.includes('--send-admin')||process.argv.includes('--video-admin');
const configuration=JSON.parse(await readFile('/root/.openclaw/openclaw.json','utf8'));
const env=await readFile('/root/llbot/secrets/openclaw-onebot.env','utf8');
for(const line of env.split('\n')){const m=/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);if(m)process.env[m[1]]=m[2].replace(/^(['"])(.*)\1$/u,'$2');}
const account=resolveOneBotAccount(configuration,'default');
const service=await XhsService.create({dataDir:join(root,'xhs'),backend:new ReachXhsBackend(),completeAlbums:true,maxVideoBytes:25*1024*1024});
service.store.db.exec('CREATE TABLE IF NOT EXISTS onebot_request_owners(request TEXT PRIMARY KEY,origin TEXT NOT NULL,peer TEXT NOT NULL)');service.start({intervalMs:250});
const store=new OperationStore(join(root,'operations.sqlite')),rows=[],deliveries=[];
const queue=new DeliveryQueue({store,config:async()=>configuration,send:async args=>{
 const row=store.db.prepare("SELECT request FROM deliveries WHERE id=?").get(args.payloads[0].channelData.onebotDelivery.id),req=JSON.parse(row.request);
 const entry={accountId:req.accountId,target:req.target,nodes:req.parts[0].nodes.map(n=>({title:n.title,kinds:n.media.map(m=>m.type),count:n.media.length}))};
 deliveries.push(entry);
 if(real&&req.target.type==='private'&&req.target.id==='700000003'&&req.accountId==='default'){
  const r=await sendForwardTransport({...account,deliveryAdmission:()=>true},'private','700000003',req.parts[0].nodes);entry.realQQ=true;entry.messageId=String(r.data?.message_id);return{status:'sent',receipt:{primaryPlatformMessageId:entry.messageId}};
 }
 entry.realQQ=false;return{status:'sent',receipt:{primaryPlatformMessageId:'captured-'+deliveries.length}};
}});
try{
 for(const [label,context,params] of [
  ['admin-image',{accountId:'default',scope:'private',senderId:'700000003'},{query:'爱莉希雅 cos',post_count:2,media_type:'image',rank:'likes'}],
  ['guest-group-video',{accountId:'default',scope:'group',groupId:'700000012',senderId:'188888888',explicit:true,roleCount:1},{query:'猫咪 视频',post_count:1,media_type:'video'}],
 ]){
  if(label==='admin-image'&&process.argv.includes('--skip-image'))continue;
  if(label==='guest-group-video'&&process.argv.includes('--skip-video'))continue;
  if(label==='guest-group-video'&&process.argv.includes('--video-admin'))Object.assign(context,{scope:'private',senderId:'700000003',groupId:undefined});
  const start=Date.now(),c={...context,requestId:'reach-media-'+label+'-'+Date.now()};
  const r=await executeXhsOperation('media_workflow',params,c,{service,queue});assert.equal(r.ok,true,JSON.stringify(r.error));
  const row={label,elapsedMs:Date.now()-start,mediaCount:r.data.media_count,postCount:r.data.posts.length,timings:r.data.timings,delivery:deliveries.at(-1)};rows.push(row);console.log(JSON.stringify(row));await writeFile(join(root,'partial-report.json'),JSON.stringify({rows,deliveries},null,2),{mode:0o600});
 }
 const cases=[['default','private','700000003'],['default','private','188888888'],['default','group','188888888'],['yuexia','group','188888889']];
 const source=service.store.db.prepare("SELECT data FROM cache WHERE json_extract(data,'$.note.type')='normal' LIMIT 1").get();assert.ok(source);const target=JSON.parse(source.data).source_url;
 const concurrent=await Promise.all(cases.map(async([accountId,scope,senderId],i)=>{
  const c={accountId,scope,senderId,...(scope==='group'?{groupId:accountId==='yuexia'?'700000011':'700000012',explicit:true,roleCount:1}:{}),requestId:'concurrent-'+Date.now()+'-'+i};
  // All concurrent cases are captured, including the admin, to avoid duplicate real sends.
  if(real&&senderId==='700000003')c.senderId='188888887';
  const start=Date.now(),out=await executeBusinessTool({name:'xhs_media_workflow',params:{ref_ids:[target]},context:c,sessionKey:'accept:'+i,callId:'call:'+i,store,xhsExecute:(op,p,c,o)=>executeXhsOperation(op,p,c,{...o,service,queue})}),r=out.details.xhs;assert.equal(r?.ok,true,JSON.stringify(out.details));return{accountId,scope,senderId:c.senderId,elapsedMs:Date.now()-start,mediaCount:r.data.media_count,deliveryId:r.data.delivery_id};
 }));
 assert.equal(new Set(concurrent.map(x=>x.deliveryId)).size,4);
 const report={ok:true,realProviders:true,realDownloads:true,realQQMessages:deliveries.filter(x=>x.realQQ).length,rows,concurrent,deliveries,permissionGroups:loadFeatureConfig().features.xiaohongshu.groupIds};
 await writeFile(join(root,'report.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify({ok:true,realQQMessages:report.realQQMessages,concurrent:concurrent.length}));
}finally{await service.close();store.close();}

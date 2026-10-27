import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.env.ONEBOT_CONFIG_ROOT;
const { BUSINESS_TOOLS } = await import('../../src/src/features/catalog.js');
const { executeBusinessTool } = await import('../../src/src/features/tools.js');
const { OperationStore } = await import('../../src/src/access/operations.js');
const store = new OperationStore(join(root, 'operations.sqlite'));
const image = join(root, 'fixture.png');
writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV2sAAAAASUVORK5CYII=', 'base64'));
const cases = {
 x_search_posts:{query:'synthetic'},x_inspect_posts:{ref_ids:['https://x.com/i/status/20']},x_media_workflow:{query:'synthetic'},
 reminder_create:{content:'离线提醒',delaySeconds:600}, reminder_list:{}, reminder_cancel:{reminderId:'aaaaaaaaaaaa'},
 tts_synthesize:{text:'这是测试语音。'},
 adsb_query:{query:'health'}, alas_status:{query:'status'}, alas_screenshot:{}, rewards_summary:{}, rewards_control:{action:'start'},
 downloads_query:{query:'status'}, qzone_read:{query:'msglist',target:'700000003'}, quota_query:{}, quota_refresh:{},
 onebot_image_generate:{prompt:'synthetic garden'}, image_edit:{prompt:'synthetic edit',image}, image_reference:{character:'synthetic character',prompt:'synthetic garden'},
 downloads_control:{action:'stop',hash:'a'.repeat(40)}, qzone_publish:{action:'publish',content:'synthetic only',image},
 qzone_interact:{action:'comment',target:'700000003',tid:'synthetic-tid',content:'synthetic only'}, network_status:{}, network_control:{action:'restart'},
 bilibili_status:{}, bilibili_subscribe:{action:'add',uid:'123456',event:'all'}, automation_query:{}, xhs_search_posts:{query:'synthetic'}, xhs_inspect_posts:{ref_ids:['https://www.xiaohongshu.com/explore/0123456789abcdef01234567?xsec_token=synthetic']}, xhs_read_comments:{ref_id:'https://www.xiaohongshu.com/explore/0123456789abcdef01234567?xsec_token=synthetic'}, xhs_get_profile:{user_id:'synthetic'}, xhs_list_images:{ref_id:'https://www.xiaohongshu.com/explore/0123456789abcdef01234567?xsec_token=synthetic'}, xhs_download_images:{image_ids:['img-synthetic']}, xhs_download_video:{ref_id:'https://www.xiaohongshu.com/explore/0123456789abcdef01234567?xsec_token=synthetic'}, xhs_job_status:{job_id:'job-synthetic'}, xhs_cancel_job:{job_id:'job-synthetic'}, xhs_read_artifact:{artifact_id:'art-synthetic'}, xhs_send_media:{}, xhs_media_workflow:{query:"synthetic"},
 automation_manage:{action:'create',name:'synthetic-only',message:'synthetic reminder',cron:'0 12 * * *',groupId:'700000011'}, alas_control:{action:'stop'},
};
assert.deepEqual(Object.keys(cases).sort(),Object.keys(BUSINESS_TOOLS).filter(name=>!BUSINESS_TOOLS[name].reachOperation).sort());
let runs=0, approvals=0, negative=0;
for(const [name,params] of Object.entries(cases)) {
 if (name.startsWith('reminder_') || name.startsWith('xhs_') || name.startsWith('x_')) continue; // Stateful local reminders have their own scheduler/delivery matrix.
 const context={scope:'group',groupId:'700000011',senderId:'700000003',accountId:'default',explicit:true,roleCount:1,requestId:'fixture-'+name,mediaPaths:[image]};
 const input={name,params,context,callId:'fixture-'+name,sessionKey:'isolated:executor-matrix',store,run:async(file,argv,options)=>{
  runs++;assert.equal(options.shell,false);assert.ok(file.startsWith('/'));assert.ok(Array.isArray(argv));
  return{stdout:name==='tts_synthesize'?JSON.stringify({ok:true,preset:'elysia-light-v1',audio_output:image}):BUSINESS_TOOLS[name].feature==='images'||name==='alas_screenshot'?`image_output=${image}\nvisual_verification=passed\n`:'{"ok":true,"simulated":true}'};
 }};
 let result=await executeBusinessTool(input);
 if(BUSINESS_TOOLS[name].approval){assert.equal(result.details.status,'not_executed');const op=store.get(result.details.operationId);store.approve(op.id,op.fingerprint,'allow-once');approvals++;result=await executeBusinessTool(input);}
 assert.equal(result.details.status,'succeeded',name+':'+JSON.stringify(result));
 const previous=runs;assert.equal((await executeBusinessTool({...input,callId:'new-model-call-id'})).details.status,'succeeded');assert.equal(runs,previous);
 for(const guest of [{...context,senderId:'188888888'}, {...context,senderId:'188888889',scope:'private',groupId:undefined}]) {
  if(name==='tts_synthesize')continue;
  if(guest.scope==='group'&&['quota_query','quota_refresh'].includes(name))continue;
  await assert.rejects(executeBusinessTool({...input,context:guest,callId:'guest-'+name}),/permission denied/u);negative++;
 }
}
assert.equal(runs,23);console.log(JSON.stringify({tools:runs,oneUseApprovals:approvals,unauthorizedCallsBlocked:negative,duplicateExecutions:0,realBusinessWrites:0}));store.close();

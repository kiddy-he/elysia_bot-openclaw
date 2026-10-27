// Real model acceptance with recorded public posts and captured text delivery.
// No QQ, XHS, SMS, session or configuration writes.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {join,resolve} from 'node:path';
import {createMediaCompletion} from '../src/src/media-completion.js';
import {prepareMediaReply} from '../src/src/media-reply.js';
import {loadModelRouting} from '../src/src/model-routing.js';
const dir=resolve(process.argv[2]??'/root/.openclaw/state/media-main-switch-20261023');
await mkdir(dir,{recursive:true,mode:0o700});
const corpus=JSON.parse(await readFile('/root/.openclaw/state/media-summary-comparison-20261023/input.json','utf8'));
const routing=loadModelRouting();const rows=[];
for(const data of corpus.cases){
 const agentId=data.feature==='x'?'main':'qq-g700000012-elysia-normal-main';
 const started=performance.now(),events=[],sent=[];
 const c=createMediaCompletion({feature:data.feature,
  prepare:input=>prepareMediaReply({...input,agentId,originalRequest:data.original_request,
   conversationContext:JSON.stringify(data.conversation_fixture),guestAddress:'测试用户',recipientKind:data.feature==='x'?'admin':'guest',
   generationRoute:routing.conversation,reviewRoute:routing.textReview,onEvent:e=>events.push(e)}),
  send:async text=>{sent.push({text,atMs:Math.round(performance.now()-started)});return {messageId:'captured-text',renderedText:text};},
 });
 c.selected(data.feature,data.posts);
 // Synthetic valid host receipt only, never contact QQ. Media receipt arrives
 // immediately to exercise the new remaining preparation budget explicitly.
 await c.complete(data.feature,{ok:true,data:{delivery_status:'delivered',delivery_id:'captured-forward',receipt:{message_id:'captured-media'},media_count:4,posts:data.posts}});
 const done=await c.done;c.cancel();
 const row={feature:data.feature,agentId,realLLM:true,realQQ:false,realSMS:false,syntheticReceipt:true,syntheticHistory:true,
  elapsedMs:Math.round(performance.now()-started),events,sent,handled:done.handled,
  approvedModelReply:events.length===2&&events.every(e=>e.ok)&&!sent[0]?.text.startsWith(`${data.feature==='x'?'X':'小红书'} 的 `)};
 rows.push(row);await writeFile(join(dir,'reply-results.json'),JSON.stringify(rows,null,2),{mode:0o600});
 console.log(JSON.stringify({feature:row.feature,elapsedMs:row.elapsedMs,events,approvedModelReply:row.approvedModelReply}));
 if(!row.approvedModelReply||sent.length!==1)process.exitCode=1;
}

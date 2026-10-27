// Explicit local acceptance: synthetic inbound admin message, real LLM/X and captured QQ.
import http from 'node:http';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,copyFile,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
const require=createRequire('/root/.openclaw/extensions/openclaw-onebot/package.json');
const {WebSocketServer}=require('ws');
const root=process.argv[2];if (!root?.startsWith('/root/.openclaw/state/x-integration-20261023/live-')) throw new Error('isolated live-* acceptance root required');
await mkdir(root,{recursive:true,mode:0o700});
const live=JSON.parse(await readFile('/root/.openclaw/openclaw.json','utf8'));
const routes=JSON.parse(await readFile('/root/.openclaw/onebot-workspaces.json','utf8'));
const env={...process.env};
for(const line of (await readFile('/root/llbot/secrets/openclaw-onebot.env','utf8')).split('\n')) {
 const m=/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);if(m) env[m[1]]=m[2].replace(/^(['"])(.*)\1$/u,'$2');
}
const captureOnly=true;
const platform=process.env.X_ACCEPT_PLATFORM??'x';
if(!['x','xiaohongshu'].includes(platform))throw new Error('invalid acceptance platform');
const scope=process.env.X_ACCEPT_SCOPE ?? 'private';
const sender=process.env.X_ACCEPT_SENDER ?? '700000003';
const group=process.env.X_ACCEPT_GROUP ?? '700000012';
if (!['private','group'].includes(scope) || !/^[1-9][0-9]{4,19}$/u.test(sender) || !/^[1-9][0-9]{4,19}$/u.test(group)) throw new Error('invalid acceptance identity');
if ((scope !== 'private' || sender !== '700000003') && !captureOnly) throw new Error('public acceptance must capture outbound instead of contacting users/groups');
const wsConnections=new Map(),receipts=[];
const server=http.createServer(async(req,res)=>{
 try {
  const chunks=[];for await(const c of req) chunks.push(c);const bytes=Buffer.concat(chunks);const body=bytes.length?JSON.parse(bytes):{};
  const startedAt=Date.now();
  const action=req.url.replace(/^\/default\//u,'').split('?')[0];
  const sendActions=['send_private_msg','send_private_forward_msg','send_group_msg','send_group_forward_msg','upload_private_file'];
  const expectedTarget=scope === 'group' ? body.group_id : body.user_id;
  if (captureOnly && sendActions.includes(action)) {
   if (String(expectedTarget)!==String(scope==='group'?group:sender) || action.includes('group')!==(scope==='group')) throw new Error('captured acceptance destination mismatch');
   const entry={at:Date.now(),action,ok:true,captured:true,messageId:900000+receipts.length,nodeTypes:body.messages?.map(n=>n.data.content.map(p=>p.type)),titles:body.messages?.map(n=>n.data.content.filter(p=>p.type==='text').map(p=>p.data.text).join('')),types:body.message?.map(p=>p.type),text:body.message?.filter(p=>p.type==='text').map(p=>p.data?.text??'').join('').slice(0,2000)};
   receipts.push(entry);await appendFile(join(root,'qq-receipts.jsonl'),JSON.stringify(entry)+'\n',{mode:0o600});
   res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({status:'ok',retcode:0,data:{message_id:entry.messageId}}));return;
  }
  if(captureOnly && ['get_group_info','get_group_member_info','get_group_member_list','get_stranger_info','get_friend_list'].includes(action)) {
   const member={user_id:Number(sender),nickname:'测试用户',card:'测试群成员',role:'member'};
   const data=action==='get_group_info'?{group_id:Number(group),group_name:'隔离验收群'}:action.endsWith('_list')?[member]:member;
   res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({status:'ok',retcode:0,data}));return;
  }
  const allowed=['get_login_info','get_stranger_info','get_friend_list','get_msg','get_private_msg_history','get_friend_msg_history','send_private_msg','send_private_forward_msg','upload_private_file','get_version_info','get_status','set_msg_emoji_like'];
  if(!allowed.includes(action)) throw new Error('acceptance HTTP action denied: '+action);
  if(body.user_id!=null && String(body.user_id)!=='700000003') throw new Error('acceptance target denied');

  const response=await fetch(`http://127.0.0.1:3002/${action}`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${env.ONEBOT_ACCESS_TOKEN}`},body:JSON.stringify(body),signal:AbortSignal.timeout(120000)});
  const text=await response.text();let result;try{result=JSON.parse(text);}catch{}
  if(['send_private_msg','send_private_forward_msg','upload_private_file'].includes(action)){
   const entry={at:Date.now(),startedAt,durationMs:Date.now()-startedAt,action,ok:result?.retcode===0,messageId:result?.data?.message_id,fileId:result?.data?.file_id,forwardId:result?.data?.forward_id,nodeTypes:body.messages?.map(n=>n.data.content.map(p=>p.type)),titles:body.messages?.map(n=>n.data.content.filter(p=>p.type==='text').map(p=>p.data.text).join('')),types:body.message?.map(p=>p.type),fileName:body.name,text:body.message?.filter(p=>p.type==='text').map(p=>p.data?.text??'').join('').slice(0,2000)};receipts.push(entry);await appendFile(join(root,'qq-receipts.jsonl'),JSON.stringify(entry)+'\n',{mode:0o600});
  }
  res.writeHead(response.status,{'Content-Type':'application/json'});res.end(text);
 }catch(e){res.writeHead(502,{'Content-Type':'application/json'});res.end(JSON.stringify({status:'failed',retcode:502,message:e.message}));}
});
const wsServer=new WebSocketServer({noServer:true});
server.on('upgrade',(req,socket,head)=>wsServer.handleUpgrade(req,socket,head,ws=>{
 wsConnections.set('default',ws);ws.on('close',()=>wsConnections.delete('default'));
 ws.on('message',bytes=>{const v=JSON.parse(bytes);if(v.action)ws.send(JSON.stringify({status:'ok',retcode:0,echo:v.echo,data:v.action==='get_login_info'?{user_id:700000006,nickname:'爱莉希雅'}:{}}));});
}));
await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
const reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const gatewayPort=reserve.address().port;await new Promise(r=>reserve.close(r));
for(const name of ['onebot-features.json','onebot-model-routing.json','onebot-role-routing.json','onebot-executors.json','onebot-delivery.json','onebot-bilibili.json','onebot-services.json','onebot-xhs.json','onebot-x.json'])await copyFile((process.env.X_ACCEPT_CONFIG_ROOT??'/root/.openclaw')+'/'+name,join(root,name));
const bili=JSON.parse(await readFile(join(root,'onebot-bilibili.json')));bili.enabled=false;await writeFile(join(root,'onebot-bilibili.json'),JSON.stringify(bili),{mode:0o600});
for(const [id,entry] of Object.entries(live.agents.entries)){
 const workspace=join(root,'workspaces',id);await mkdir(workspace,{recursive:true,mode:0o700});
 await writeFile(join(workspace,'AGENTS.md'),'仅使用本次明确授权的业务工具。不要读取任何私人记忆或其他工作区。当前为隔离验收，按真实事件中的身份和会话权限执行搜索或完整媒体发送，收到回执才能确认成功。');
 await writeFile(join(workspace,'SOUL.md'),'你是爱莉希雅，自然简洁地用中文回答。仅管理员可称舰长，普通用户按昵称称呼。优先完成请求，不能编造工具结果。');
 entry.workspace=workspace;delete entry.agentDir;entry.skills=[];
 if(routes.agents[id])routes.agents[id].workspace=workspace;
}
live.agents.defaults.workspace=join(root,'workspaces/main');live.agents.defaults.heartbeat={every:'6h',target:'none'};
live.gateway={mode:'local',bind:'loopback',port:gatewayPort,auth:{mode:'token',token:randomUUID()}};
live.cron={enabled:false};live.plugins={allow:['openclaw-onebot','openai'],load:{paths:['/root/.openclaw/extensions/openclaw-onebot']},slots:{memory:'none'},entries:{'openclaw-onebot':{enabled:true,hooks:{allowConversationAccess:true,allowPromptInjection:true}},openai:{enabled:true}}};
live.channels={onebot:{...live.channels.onebot,wsUrl:`ws://127.0.0.1:${port}/ws/default`,httpUrl:`http://127.0.0.1:${port}/default`,accounts:{},groupAutoReact:false}};
await writeFile(join(root,'openclaw.json'),JSON.stringify(live),{mode:0o600});await writeFile(join(root,'onebot-workspaces.json'),JSON.stringify(routes),{mode:0o600});
Object.assign(env,{ONEBOT_CONFIG_ROOT:root,OPENCLAW_STATE_DIR:root,OPENCLAW_CONFIG_PATH:join(root,'openclaw.json'),ONEBOT_OPERATIONS_DB:join(root,'state/business/operations.sqlite')});
const child=spawn('/usr/local/bin/openclaw',['gateway','run','--port',String(gatewayPort),'--bind','loopback'],{env,stdio:['ignore','pipe','pipe']});
let logs='';const log=b=>{logs+=b;void appendFile(join(root,'gateway.log'),b,{mode:0o600});};child.stdout.on('data',log);child.stderr.on('data',log);
const pause=ms=>new Promise(r=>setTimeout(r,ms));
try{
 for(let i=0;i<900&&!wsConnections.has('default');i++){if(child.exitCode!==null)throw new Error('acceptance gateway exited '+child.exitCode);await pause(200);}
 if(!wsConnections.has('default'))throw new Error('OneBot acceptance gateway not ready');
 const message=process.env.X_ACCEPT_MESSAGE??'下载这个X帖子的全部图片和视频发给我：https://x.com/oshtru/status/1577855540407197696 ，文字回复，不使用语音。';
 const messageId=-(Math.floor(Date.now()/1000));
 const inboundAt=Date.now();
 wsConnections.get('default').send(JSON.stringify({post_type:'message',message_type:scope,sub_type:scope==='group'?'normal':'friend',self_id:700000006,time:Math.floor(Date.now()/1000),message_id:messageId,user_id:Number(sender),...(scope==='group'?{group_id:Number(group)}:{}),sender:{user_id:Number(sender),nickname:captureOnly?'测试用户':'管理员',role:'member'},message:[...(scope==='group'?[{type:'at',data:{qq:'700000006'}}]:[]),{type:'text',data:{text:message}}],raw_message:scope==='group'?`[CQ:at,qq=700000006] ${message}`:message}));
 await writeFile(join(root,'inbound.json'),JSON.stringify({inboundAt,syntheticInbound:true,realLLM:true,realX:platform==='x',realXhs:platform==='xiaohongshu',realQq:!captureOnly,captureOnly,scope,sender,messageId,message}),{mode:0o600});
 console.log('Injected trusted '+scope+' acceptance message; waiting for model tools and '+(captureOnly?'captured delivery':'QQ receipts')+'.');
 let finished=false,finalAt;
 for(let i=0;i<Math.ceil(Number(process.env.X_ACCEPT_MAX_WAIT_MS??900000)/500);i++){
  await pause(500);if(child.exitCode!==null)throw new Error('acceptance gateway exited '+child.exitCode);
  if (/deliver\(final\)|Media completion event=completed/u.test(logs)) finalAt ??= Date.now();
  if (finalAt && Date.now()-finalAt>15000 && receipts.some(receipt=>(receipt.at>=finalAt || /Media completion event=completed/u.test(logs)) && receipt.ok && receipt.types?.includes('text'))) {finished=true;break;}

 }
 const db=new DatabaseSync(join(root,'state/business/operations.sqlite'));
 const tools=db.prepare('SELECT kind,state,result FROM operations ORDER BY created').all().map(row=>{
  const value=JSON.parse(row.result ?? '{}'), data=(value.x??value.xhs)?.data;
  return {name:row.kind,state:row.state,jobState:data?.state,deliveryStatus:data?.delivery_status,receipt:data?.receipt,error:(value.x??value.xhs)?.error ?? value.error};
 });db.close();
 const mediaReceipt=receipts.find(r=>r.ok&&r.action.includes('forward'));
 const finalReceipt=receipts.find(r=>r.ok&&r.types?.includes('text')&&(!mediaReceipt||r.at>=mediaReceipt.at));
 const targetMs=Number(process.env.X_ACCEPT_TARGET_MS??60000);
 const performance={targetMs,mediaToTextMs:mediaReceipt&&finalReceipt?finalReceipt.at-mediaReceipt.at:null,inboundToTextMs:finalReceipt?finalReceipt.at-inboundAt:null,fastCompletion:/Media completion event=completed/u.test(logs),inboundToMediaMs:mediaReceipt?mediaReceipt.at-inboundAt:null,withinTarget:mediaReceipt?mediaReceipt.at-inboundAt<=targetMs:false};
 const result={performance,inboundAt,syntheticInbound:true,realLLM:true,realX:platform==='x',realXhs:platform==='xiaohongshu',realQq:!captureOnly,captureOnly,scope,sender,finished,tools,receipts};
 await writeFile(join(root,'result.json'),JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify({root,...result}));
 if(!finished)process.exitCode=1;
}finally{
 child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),pause(5000)]);if(child.exitCode===null)child.kill('SIGKILL');
 for(const ws of wsConnections.values())ws.close();wsServer.close();await new Promise(r=>server.close(r));
}

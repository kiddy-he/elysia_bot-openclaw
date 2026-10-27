import http from 'node:http';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {mkdir,writeFile,readFile,copyFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const root='/root/.openclaw/state/modular-implementation-20261016/native-integration';
await mkdir(root,{recursive:true,mode:0o700});
for(const name of ['onebot-app-config.json','onebot-model-routing.json','onebot-role-routing.json','onebot-executors.json','onebot-features.json','onebot-services.json','onebot-workspaces.json','onebot-delivery.json','onebot-bilibili.json'])await copyFile('/root/.openclaw/'+name,root+'/'+name);
await mkdir(root+'/secrets',{recursive:true,mode:0o700});
const syntheticDeliveryKey=randomUUID()+randomUUID();await writeFile(root+'/secrets/onebot-delivery.key',syntheticDeliveryKey,{mode:0o600});
const sends=[];
const server=http.createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;let body={};try{body=JSON.parse(text)}catch{}
 if(req.url.startsWith('/send_')){sends.push({endpoint:req.url,body});if(JSON.stringify(body.message).includes('SIMULATE_RECEIPT_LOST')){res.destroy();return;}}
 res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({status:'ok',retcode:0,data:req.url==='/get_login_info'?{user_id:700000006,nickname:'offline acceptance'}:{message_id:8100000+sends.length}}));});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const fakePort=server.address().port;
const config={gateway:{mode:'local',bind:'loopback',port:21989,auth:{mode:'token',token:randomUUID()}},cron:{enabled:false},
 agents:{defaults:{workspace:root+'/workspace',heartbeat:{every:'0m'}},entries:{main:{default:true}}},
 channels:{onebot:{enabled:true,httpUrl:`http://127.0.0.1:${fakePort}`,wsUrl:'ws://127.0.0.1:21988',allowFrom:['private:700000003','group:700000011'],sharedDir:root+'/shared',containerSharedDir:root+'/shared'}},
 plugins:{allow:['openclaw-onebot'],load:{paths:['/root/.openclaw/extensions/openclaw-onebot']},slots:{memory:'none'},entries:{'openclaw-onebot':{enabled:true}}}};
await writeFile(root+'/config.json',JSON.stringify(config,null,2),{mode:0o600});
const child=spawn('/usr/local/bin/openclaw',['gateway','run','--port','21989','--bind','loopback'],{env:{...process.env,OPENCLAW_CONFIG_PATH:root+'/config.json',OPENCLAW_STATE_DIR:root+'/state',ONEBOT_CONFIG_ROOT:root,ONEBOT_OPERATIONS_DB:root+'/operations.sqlite'},stdio:['ignore','pipe','pipe']});
let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
let report;
try{
 let ready=false;
 for(let i=0;i<60;i++){if(child.exitCode!==null)throw new Error('isolated gateway exited '+child.exitCode);try{const r=await fetch('http://127.0.0.1:21989/onebot/bilibili/events',{method:'POST',body:'{}'});if(r.status===503){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}
 if(!ready)throw new Error('isolated gateway not ready');
 const key=syntheticDeliveryKey;
 const submit=async(body)=>{const response=await fetch('http://127.0.0.1:21989/onebot/internal/deliver',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(body)});return {http:response.status,...await response.json()};};
 const body={service:'alas-monitor',targetId:'700000003',dedupeKey:'offline-native-'+randomUUID(),text:'原生持久投递离线验收。'.repeat(500)};
 const first=await submit(body);assert.equal(first.state,'accepted',JSON.stringify(first));assert.equal(sends.length,2);assert.equal(first.receipt.platformMessageIds.length,2);
 const second=await submit(body);assert.equal(second.state,'accepted');assert.equal(sends.length,2);
 const png=root+'/temporary.png';await writeFile(png,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV2sAAAAASUVORK5CYII=','base64'));
 const image=await submit({service:'alas-screenshot',targetId:'700000003',dedupeKey:'offline-image-'+randomUUID(),path:png});assert.equal(image.state,'accepted',JSON.stringify(image));assert.equal(sends.length,3);assert.equal(sends[2].body.message[0].type,'image');
 const wrong=await submit({...body,targetId:'12345678',dedupeKey:randomUUID()});assert.equal(wrong.http,400);assert.equal(sends.length,3);
 const unauthorized=await fetch('http://127.0.0.1:21989/onebot/internal/deliver',{method:'POST',body:'{}'});assert.equal(unauthorized.status,401);
 const faultBody={service:'alas-monitor',targetId:'700000003',dedupeKey:'offline-lost-'+randomUUID(),text:'SIMULATE_RECEIPT_LOST'};
 const uncertain=await submit(faultBody);assert.notEqual(uncertain.state,'accepted');assert.equal(sends.length,4);
 const cached=await submit(faultBody);assert.equal(cached.id,uncertain.id);assert.equal(cached.state,uncertain.state);assert.equal(sends.length,4);
 const run=promisify(execFile);const env={...process.env,ONEBOT_CONFIG_ROOT:root,OPENCLAW_CONFIG_PATH:root+'/config.json',ONEBOT_DELIVERY_ID:'wrapper-'+randomUUID()};
 const textFile=root+'/wrapper-alert.txt';await writeFile(textFile,'ALAS wrapper simulation only');
 const beforeWrappers=sends.length;
 for(const [wrapper,file]of[['send-text.sh',textFile],['send-image.sh',png]]){
  const script=fileURLToPath(new URL('../integrations/alas/'+wrapper,import.meta.url));
  for(let attempt=0;attempt<2;attempt++){const result=await run('/bin/bash',[script,file],{env:{...env,ONEBOT_DELIVERY_ID:env.ONEBOT_DELIVERY_ID+':'+wrapper},timeout:30000});assert.match(result.stdout,/STATUS=ok/u);}
 }
 assert.equal(sends.length-beforeWrappers,2);
 const adapter=fileURLToPath(new URL('../../extensions/openclaw-onebot/dist/src/channel.js',import.meta.url));
 const guardSource=`import assert from 'node:assert/strict';import{registerHooks,createRequire}from'node:module';import{pathToFileURL}from'node:url';const require=createRequire('/opt/node-v25.9.0-linux-x64/lib/node_modules/openclaw/package.json');const aliases=Object.fromEntries(['core','media-runtime','channel-outbound','runtime-store'].map(name=>{const key='openclaw/plugin-sdk/'+name;return[key,pathToFileURL(require.resolve(key)).href];}));registerHooks({resolve(specifier,context,next){return next(aliases[specifier]??specifier,context);}});const{onebotPlugin}=await import(${JSON.stringify('file://'+adapter)});await assert.rejects(onebotPlugin.outbound.sendPayload({to:'group:700000011',payload:{text:'forged',mediaUrl:${JSON.stringify(png)}},accountId:'default',cfg:{}}),/业务来源/u);await assert.rejects(onebotPlugin.outbound.sendMedia({}),/统一持久投递/u);console.log('unowned-media-blocked');`;
 assert.match((await run(process.execPath,['--input-type=module','-e',guardSource],{env:{...env,OPENCLAW_STATE_DIR:root+'/state'},timeout:30000})).stdout,/unowned-media-blocked/u);
 assert.equal(sends.length-beforeWrappers,2);
 report={ok:true,nativeSdk:true,acceptedParts:5,lostReceiptAttempts:1,lostReceiptNotReplayed:true,alasWrappersVerified:true,unownedMediaBlocked:true,platform:'local fake OneBot only',attemptedParts:sends.length,textParts:2,imageParts:1,dedupe:true,unauthorizedBlocked:true,wrongTargetBlocked:true,realQqMessages:0,first,image};
 console.log(JSON.stringify({ok:true,acceptedParts:5,lostReceiptAttempts:1,lostReceiptNotReplayed:true,alasWrappersVerified:true,unownedMediaBlocked:true,nativeSdk:true,realQqMessages:0}));
}catch(error){report={ok:false,error:error.message};console.log(JSON.stringify(report));process.exitCode=1;}
finally{child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,5000))]);if(child.exitCode===null)child.kill('SIGKILL');server.closeAllConnections();await new Promise(r=>server.close(r));await writeFile(root+'/gateway.log',logs,{mode:0o600});await writeFile(root+'/report.json',JSON.stringify(report,null,2)+'\n',{mode:0o600});}

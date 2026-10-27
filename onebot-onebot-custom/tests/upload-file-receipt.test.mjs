import test from 'node:test';
import assert from 'node:assert/strict';
import {matchUploadedPrivateFile} from '../src/src/outbound.js';
const now=1792565016000;
const criteria={selfId:'700000006',targetId:'700000003',fileName:'test.mp4',bytes:1234,startedAt:now,previousIds:['old']};
const sent={message_id:'new',message_type:'private',time:now/1000,sender:{user_id:700000006},target_id:700000003,message:[{type:'file',data:{file:'test.mp4',file_id:'actual-file',file_size:'1234'}}]};
test('successful file upload can reconcile an exact new outgoing private file receipt',()=>assert.equal(matchUploadedPrivateFile([sent],criteria).message_id,'new'));
test('receipt lookup rejects a missing trusted self account ID',()=>assert.equal(matchUploadedPrivateFile([sent],{...criteria,selfId:undefined}),undefined));
test('old, foreign, renamed, wrong size, incoming and ID-less files cannot establish upload success',()=>{
 for(const mutate of [m=>{m.message_id='old';},m=>{m.time-=2;},m=>{m.sender.user_id=700000003;},m=>{m.target_id=188888888;},m=>{m.message[0].data.file='different.mp4';},m=>{m.message[0].data.file_size='1235';},m=>{m.message[0].data.file_id='';}]){const m=structuredClone(sent);mutate(m);assert.equal(matchUploadedPrivateFile([m],criteria),undefined);}
});

test('file transport uploads once then uses actual private-history message ID when upload returns only file metadata',async t=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {createServer}=await import('node:http');
 const {uploadFileTransport}=await import('../src/src/outbound.js');
 const dir=await mkdtemp(join(tmpdir(),'file-upload-receipt-'));const file=join(dir,'test.mp4');await writeFile(file,Buffer.alloc(1234));
 let uploads=0,historyReads=0;
 const server=createServer(async(req,res)=>{
  for await(const _ of req){}
  let data;
  if(req.url==='/get_login_info')data={user_id:700000006};
  else if(req.url==='/upload_private_file'){uploads++;data={file_id:'file-from-upload'};}
  else if(req.url==='/get_friend_msg_history'){historyReads++;data={messages:uploads?[{...sent,time:Math.floor(Date.now()/1000)}]:[]};}
  else throw new Error('unexpected endpoint');
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({status:'ok',retcode:0,data}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
 const result=await uploadFileTransport({accountId:'default',httpUrl:`http://127.0.0.1:${server.address().port}`,config:{sharedDir:dir,containerSharedDir:dir}},'private','700000003',file,'test.mp4');
 assert.equal(result.data.message_id,'new');assert.equal(uploads,1);assert.equal(historyReads,2);
});

for (const [scope,target] of [['private','700000003'],['group','700000012']]) test(`forward transport sends image and native video nodes to ${scope} through the dedicated API with actual bot identity`,async t=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {createServer}=await import('node:http');
 const {sendForwardTransport}=await import('../src/src/outbound.js');
 const dir=await mkdtemp(join(tmpdir(),'forward-transport-'));const path=join(dir,'test.mp4');await writeFile(path,Buffer.from('fixture'));
 const calls=[];const server=createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);calls.push({path:req.url,body});
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({status:'ok',retcode:0,data:req.url==='/get_login_info'?{user_id:700000006}:{message_id:123456,forward_id:'resource-only'}}));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
 const result=await sendForwardTransport({accountId:'default',httpUrl:`http://127.0.0.1:${server.address().port}`,config:{sharedDir:dir,containerSharedDir:dir}},scope,target,[{title:'第一帖\n[CQ:at,qq=all]',media:[{type:'image',path},{type:'image',path}]},{title:'第二帖',media:[{type:'video',path}]}]);
 assert.equal(result.data.message_id,123456);assert.equal(calls.length,2);assert.equal(calls[1].path,scope==='private'?'/send_private_forward_msg':'/send_group_forward_msg');
 assert.equal(calls[1].body[scope==='private'?'user_id':'group_id'],target);assert.equal(calls[1].body.message,undefined);
 assert.deepEqual(calls[1].body.messages.map(n=>n.data.content.map(p=>p.type)),[['text','image','image'],['text','video']]);
 assert.equal(calls[1].body.messages[0].data.content[0].data.text,'【第一帖 [CQ:at,qq=all]】');
 assert.equal(calls[1].body.messages[1].data.content[0].data.text,'【第二帖】');
 for(const n of calls[1].body.messages){assert.equal(n.data.user_id,'700000006');assert.match(n.data.content[1].data.file,/^file:\/\//);}
});

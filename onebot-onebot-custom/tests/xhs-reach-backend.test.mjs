import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ReachXhsBackend} from '../src/src/xhs/backends/reach.js';
import {count,normalizeSearch} from '../src/src/xhs/domain/notes.js';
import {ReachXhsRecovery} from '../src/src/features/xhs-reach-recovery.js';
import {normalizeReachResult,REACH_ACTIONS} from '../src/src/features/reach-provider.js';
const config={home:'/synthetic/'+process.pid,user:'openclaw-reach'};
const response=data=>({stdout:JSON.stringify({ok:true,data})});
test('metrics parse visible Chinese and Latin abbreviated counts without inventing exact values',()=>{
 assert.deepEqual(count('1.2万'),{value:12000,raw:'1.2万',approximate:true});
 assert.equal(count('2.3k').value,2300);assert.equal(count('2亿').value,200000000);assert.equal(count('unknown').value,null);assert.equal(count('12').approximate,false);assert.equal(count(null),null);
});
test('Reach normalized search retains likes but does not expose raw backend fields or inferred dates',()=>{
 const r=normalizeReachResult({schema_version:1,ok:true,channel:'xiaohongshu',action:'search',items:[{title:'test',url:'https://www.xiaohongshu.com/explore/abcdef123456',published_at:'2026-10-26',raw:{likes:'1.2万',cookie:'secret'}}]},REACH_ACTIONS.reach_xhs_search);
 assert.equal(r.items[0].metrics.likes.value,12000);assert.equal(r.items[0].published_at,null);assert.equal(r.items[0].raw,undefined);assert.equal(JSON.stringify(r).includes('secret'),false);
});
test('adapter uses a fixed executable, JSON argv and preserves signed media query parameters',async()=>{
 let calls=0;const b=new ReachXhsBackend({config:{...config,home:config.home+'argv'},run:async(argv,o)=>{
  calls++;assert.equal(o.config.executable,'/opt/openclaw-agent-reach/xhs-command');assert.equal(argv[0],'inspect');assert.equal(JSON.parse(argv[1]).target,'https://www.xiaohongshu.com/explore/abcdef12?xsec_token=synthetic');
  return response({source_url:JSON.parse(argv[1]).target,note:{imageList:[{urlDefault:'https://a.xhscdn.com/i?token=keep'}]}});
 }});
 const n=await b.inspect('https://www.xiaohongshu.com/explore/abcdef12?xsec_token=synthetic');assert.equal(n.note.imageList[0].urlDefault.endsWith('?token=keep'),true);assert.equal(calls,1);
});
test('concurrent identical reads share extraction but return separate copies; caller cancellation never cancels other readers',async()=>{
 let calls=0,finish;const b=new ReachXhsBackend({config:{...config,home:config.home+'shared'},run:async()=>{calls++;return new Promise(resolve=>{finish=()=>resolve(response({rows:[]}));});}});
 const ctrl=new AbortController();const a=b.search({query:'same',limit:1},{signal:ctrl.signal});const rejected=assert.rejects(a,/cancelled/);
 const c=b.search({query:'same',limit:1});ctrl.abort();finish();await rejected;assert.deepEqual(await c,[]);assert.equal(calls,1);
 const d=await b.search({query:'same',limit:1});d.push('mutated');assert.deepEqual(await b.search({query:'same',limit:1}),[]);assert.equal(calls,1);
});
test('auth failure is never cached and unsupported latest sorting never silently becomes relevance',async()=>{
 let calls=0;const b=new ReachXhsBackend({config:{...config,home:config.home+'errors'},run:async()=>{calls++;return{stdout:JSON.stringify({ok:false,error:{code:'challenge_required'}})};}});
 for(let i=0;i<2;i++)await assert.rejects(b.search({query:'x',limit:1}),/challenge_required/);
 assert.equal(calls,2);await assert.rejects(b.search({query:'x',sort:'latest'}),/search_sort_unavailable/);assert.equal(calls,2);
});
test('search adapter rows normalize into full signed candidates and post types',async()=>{
 const rows=[{id:'0123456789abcdef01234567',xsecToken:'synthetic',modelType:'note',noteCard:{type:'video',displayTitle:'video',user:{userId:'author'},interactInfo:{likedCount:'1万'}}}];
 const b=new ReachXhsBackend({config:{...config,home:config.home+'normalize'},run:async()=>response({rows})});
 const n=normalizeSearch(await b.search({query:'x',limit:1}),{limit:1,media_type:'video'});assert.equal(n.posts[0].note_type,'video');assert.equal(n.posts[0].metrics.likes.value,10000);assert.match(n.posts[0].source_url,/xsec_token=synthetic/);
});
const ctx={accountId:'default',scope:'group',groupId:'700000012',senderId:'188888888',requestId:'turn',sessionKey:'group:user'};
async function fixture(t,overrides={}){
 const root=await mkdtemp(join(tmpdir(),'reach-qr-'));t.after(()=>rm(root,{recursive:true,force:true}));
 let now=100000,loggedIn=false,gate='login_required',verifyOk=true,allow=true;const sent=[],resumed=[];
 const c=new ReachXhsRecovery({file:join(root,'state.json'),now:()=>now,admins:()=>['700000003'],
  send:async(id,text)=>{sent.push({id,text});return{messageId:'text'};},sendQr:async(id,image,kind)=>{sent.push({id,kind});return{messageId:'qr'};},
  status:async()=>({loggedIn,gate}),prepare:async()=>({kind:gate==='challenge_required'?'security_verification':'login',image_base64:'iVBORw0KGgo='}),
  verify:async()=>{if(!verifyOk)throw Error('not_verified');},authorize:async()=>allow,resume:()=>async task=>resumed.push(task),...overrides});
 return{c,sent,resumed,set(v){now+=6000;if('loggedIn'in v)loggedIn=v.loggedIn;if('gate'in v)gate=v.gate;if('verifyOk'in v)verifyOk=v.verifyOk;if('allow'in v)allow=v.allow;}};
}
test('QR recovery sends only admin private prompts and requires actual search before one-time task resume',async t=>{
 const f=await fixture(t);f.c.remember(ctx,{recovery:false});await f.c.observe({error:{code:'login_required'}},ctx);await new Promise(r=>setImmediate(r));
 assert.equal(f.sent[0].id,'700000003');assert.equal(f.c.pending(),true);assert.equal(f.resumed.length,0);
 f.set({loggedIn:true,gate:null,verifyOk:false});await f.c.tick();assert.equal(f.resumed.length,0);
 f.c.finish(ctx);f.set({verifyOk:true});await f.c.tick();assert.equal(f.resumed.length,1);await f.c.tick(true);assert.equal(f.resumed.length,1);
});
test('login QR changes immediately to security QR and revoked original permissions prevent resumed delivery',async t=>{
 const f=await fixture(t);f.c.remember(ctx,{recovery:false});await f.c.observe({error:{code:'login_required'}},ctx);await new Promise(r=>setImmediate(r));
 f.set({gate:'challenge_required'});await f.c.tick();assert.equal(f.sent.at(-1).kind,'security_verification');
 f.c.finish(ctx);f.set({loggedIn:true,gate:null,allow:false});await f.c.tick();assert.equal(f.resumed.length,0);assert.equal(f.c.state.tasks[0].status,'cancelled');
});
test('a recovered task blocked again never starts a login loop; unbound reply never authenticates',async t=>{
 const f=await fixture(t);f.c.remember(ctx,{recovery:true});const r=await f.c.observe({error:{code:'challenge_required'}},ctx);assert.equal(r.status,'blocked_after_login');assert.equal(f.sent.length,0);
 assert.equal(await f.c.handle({message_type:'private',user_id:700000003,message:[{type:'reply',data:{id:'unbound'}}]},'default'),false);
});

test('a completed dialog without a logged-in site flag never verifies or resumes pending work',async t=>{
 let verify=0;const f=await fixture(t,{verify:async()=>verify++});f.c.remember(ctx,{recovery:false});await f.c.observe({error:{code:'login_required'}},ctx);await new Promise(r=>setImmediate(r));f.c.finish(ctx);
 f.set({loggedIn:false,gate:null});await f.c.tick();assert.equal(verify,0);assert.equal(f.resumed.length,0);assert.equal(f.c.state.flow.status,'waiting');
});

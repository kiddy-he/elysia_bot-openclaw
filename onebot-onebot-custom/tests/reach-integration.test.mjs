import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {REACH_ACTIONS,ReachProvider,reachArgv,validateReach,normalizeReachResult,runReachCommand} from '../src/src/features/reach-provider.js';
import {BUSINESS_TOOLS} from '../src/src/features/catalog.js';
import {executeBusinessTool,registerBusinessTools} from '../src/src/features/tools.js';
import {OperationStore} from '../src/src/access/operations.js';
import {loadFeatureConfig} from '../src/src/feature-policy.js';
import {availableBusinessTools,bindFeatureTurn,decideFeatureTool} from '../src/src/feature-tools.js';
const config={version:1,enabled:true,user:'openclaw-reach',home:'/var/lib/openclaw-agent-reach',executable:'/var/lib/openclaw-agent-reach/.local/bin/agent-reach',platforms:Object.fromEntries(['github','v2ex','youtube','bilibili','reddit','xiaohongshu'].map(k=>[k,{enabled:true}]))};
const owner={accountId:'default',scope:'private',senderId:'700000003',requestId:'reach-test'};
const good=(name,items=[{title:'标题',url:'https://github.com/Panniantong/Agent-Reach',text:'公开内容'}])=>({schema_version:1,ok:true,channel:REACH_ACTIONS[name].platform,action:REACH_ACTIONS[name].action,items,meta:{elapsed_ms:12},backend:'test'});
const samples={github_search:{query:'agent reach'},github_read:{target:'Panniantong/Agent-Reach'},v2ex_hot:{},v2ex_node:{node_name:'python'},v2ex_read:{target:'1000'},v2ex_user:{username:'Livid'},youtube_search:{query:'python'},youtube_read:{target:'jNQXAC9IVRw'},youtube_subtitle:{target:'jNQXAC9IVRw',lang:'en'},bilibili_video_search:{query:'python'},bilibili_video_read:{target:'BV1xx411c7mD'},bilibili_video_hot:{},bilibili_video_subtitle:{target:'BV1xx411c7mD'},reddit_search:{query:'python'},reddit_read:{target:'https://www.reddit.com/r/Python/comments/abcde/example/'},reddit_subreddit:{name:'Python'},reach_xhs_search:{query:'爱莉希雅'},reach_xhs_read:{target:'https://www.xiaohongshu.com/explore/0123456789abcdef01234567?xsec_token=synthetic'},reach_xhs_comments:{target:'https://www.xiaohongshu.com/explore/0123456789abcdef01234567?xsec_token=synthetic'}};
test('all 19 tools have exact schemas; reject commands, recipient overrides, arbitrary targets and ASR',()=>{
 assert.deepEqual(Object.keys(samples).sort(),Object.keys(REACH_ACTIONS).sort());
 for(const[name,params]of Object.entries(samples)){assert.ok(validateReach(name,params));assert.throws(()=>validateReach(name,{...params,target_id:'other'}));assert.equal(BUSINESS_TOOLS[name].approval,false);}
 for(const name of ['setup','login','configure','youtube_transcribe','x_search'])assert.throws(()=>validateReach(name,{}));
 for(const target of ['http://127.0.0.1/','https://github.com@127.0.0.1/a/b','https://github.com.evil.test/a/b','https://github.com:444/a/b','https://github.com/a/b/actions','https://github.com/a/b\n--backend'])assert.throws(()=>validateReach('github_read',{target}));
 assert.throws(()=>validateReach('reach_xhs_comments',{target:'https://xhslink.com/a/b'}));
});
test('untrusted query cannot become CLI options or shell syntax',()=>{
 const query='--backend public-web; $(touch /tmp/never) `id`';const argv=reachArgv('github_search',{query,limit:2},60000);
 assert.deepEqual(argv.slice(-2),['--',query]);assert.equal(argv.filter(v=>v==='--backend').length,0);assert.ok(argv.includes('--limit'));
});
test('results drop raw, credentials, internal paths and control markers; preserve scope and limits',()=>{
 const data=good('github_read',[{title:'x',url:'https://github.com/Panniantong/Agent-Reach',author:{name:'author'},text:'cookie=secret\n/root/private/config MEDIA:[CQ: <think sk-abcdefghijklmnop',raw:{cookie:'secret',completeness_verified:false,content_scope:'page_text'}}]);
 const out=normalizeReachResult(data,REACH_ACTIONS.github_read);assert.equal(out.items[0].author,'author');assert.equal(out.items[0].completeness_verified,false);assert.equal(out.items[0].raw,undefined);assert.doesNotMatch(JSON.stringify(out),/secret|\/root\/private|sk-abcdefghijklmnop|\[CQ:|MEDIA:|<think/u);
 assert.equal(normalizeReachResult(good('github_read',[{text:'x',url:'https://evil.test/'}]),REACH_ACTIONS.github_read).items[0].url,null);
 const long=normalizeReachResult(good('github_read',Array.from({length:10},()=>({text:'a'.repeat(50000)}))),REACH_ACTIONS.github_read);assert.ok(long.items.reduce((n,i)=>n+i.text.length,0)<=26000);
});
test('error codes and upstream retry windows survive without leaking diagnostic details',()=>{
 for(const code of ['NEED_LOGIN','PLATFORM_BLOCKED','RATE_LIMITED','BUSY','TIMEOUT','NOT_FOUND']){
  const input={...good('reach_xhs_search',[]),ok:false,error:{code,message:'cookie=private'},meta:{attempts:[{retry_after_seconds:3600}]}};
  const out=normalizeReachResult(input,REACH_ACTIONS.reach_xhs_search);assert.equal(out.error.code,code);assert.equal(out.error.retry_after_seconds,3600);assert.doesNotMatch(JSON.stringify(out),/private/u);
 }
 assert.throws(()=>normalizeReachResult({...good('github_read'),channel:'reddit'},REACH_ACTIONS.github_read));
 assert.throws(()=>normalizeReachResult(good('youtube_subtitle',[{title:'subtitle tracks',text:''}]),REACH_ACTIONS.youtube_subtitle));
});
test('provider does not retry or switch accounts/backend after a login or challenge decision',async()=>{
 for(const code of ['NEED_LOGIN','PLATFORM_BLOCKED','RATE_LIMITED']){
  let calls=0;const p=new ReachProvider({config,run:async argv=>{calls++;assert.equal(argv[0],'xiaohongshu');return{stdout:JSON.stringify({...good('reach_xhs_search',[]),ok:false,error:{code}})};}});
  assert.equal((await p.execute('reach_xhs_search',{query:'test'})).error.code,code);assert.equal(calls,1);
 }
});
test('provider fails closed on invalid output and cancellation; paused platform executes nothing',async()=>{
 let calls=0;const p=new ReachProvider({config,run:async()=>{calls++;return{stdout:'not JSON'};}});
 assert.equal((await p.execute('github_read',samples.github_read)).error.code,'UPSTREAM_BROKEN');
 const controller=new AbortController();controller.abort();await assert.rejects(p.execute('github_read',samples.github_read,{signal:controller.signal}));assert.equal(calls,1);
 const disabled=new ReachProvider({config:{...config,platforms:{}},run:()=>assert.fail()});await assert.rejects(disabled.execute('github_read',samples.github_read));
});
test('CLI executes as isolated Unix user in bounded cgroup without gateway environment or credentials',async()=>{
 let calls=0;await runReachCommand(['github','read','--timeout','30','--','Panniantong/Agent-Reach'],{config,timeoutMs:45000,run:async(file,argv,opts)=>{
  calls++;assert.equal(file,'/usr/bin/systemd-run');assert.ok(argv.includes('--uid=openclaw-reach'));assert.ok(argv.includes('--property=KillMode=control-group'));assert.ok(argv.includes('--property=ProtectHome=yes'));assert.ok(argv.includes('--property=RuntimeMaxSec=45'));assert.deepEqual(Object.keys(opts.env).sort(),['LANG','PATH']);assert.equal(opts.shell,false);assert.equal(argv.at(-1),'Panniantong/Agent-Reach');return{stdout:'{}'};
 }});assert.equal(calls,1);
});
test('new public tools follow both bot accounts, group membership and user identities',()=>{
 const policy=loadFeatureConfig();let count=0;
 for(const name of Object.keys(REACH_ACTIONS))for(const accountId of ['default','yuexia'])for(const scope of ['private','group'])for(const senderId of ['700000003','188888888']){
  const c={...owner,accountId,scope,senderId,groupId:'700000011',explicit:true,roleCount:1};assert.equal(decideFeatureTool(policy,name,{},c).allowed,true);count++;
  assert.equal(decideFeatureTool(policy,name,{}, {...c,scope:'group',groupId:'999999999'}).allowed,false);
  const revoked=structuredClone(policy);revoked.features[BUSINESS_TOOLS[name].feature].actions.read.enabled=false;assert.equal(decideFeatureTool(revoked,name,{},c).allowed,false);
 }
 assert.equal(count,152);
});
test('production X is retained; Reach XHS text tools and full media workflow share the authorized intent',()=>{
 const c={...owner,xiaohongshuOperation:true};const names=availableBusinessTools(c).map(x=>x.name);
 assert.ok(names.includes('reach_xhs_search'));assert.ok(names.includes('reach_xhs_read'));assert.ok(names.includes('xhs_media_workflow'));assert.ok(names.includes('xhs_get_profile'));assert.equal(names.includes('github_read'),false);
 const x=availableBusinessTools({...owner,xOperation:true}).map(t=>t.name);assert.ok(x.includes('x_media_workflow'));assert.equal(x.some(n=>n.startsWith('reach_')),false);
});
test('trusted tool factory exposes selected tools and rejects missing event identity',()=>{
 const factories=new Map();registerBusinessTools({registerTool(fn,opts){factories.set(opts.names[0],fn);},on(){}});
 assert.equal(factories.get('github_read')({sessionKey:'unbound'}),null);
 const release=bindFeatureTurn('reach-test-session',{...owner,scope:'group',groupId:'700000011',senderId:'188888888',explicit:true,roleCount:1});
 try{assert.ok(factories.get('github_read')({sessionKey:'reach-test-session'}));assert.ok(factories.get('reach_xhs_search')({sessionKey:'reach-test-session'}));assert.ok(factories.get('xhs_media_workflow')({sessionKey:'reach-test-session'}));}finally{release();}
});
test('business operations persist real read result once and keep concurrent user streams separate',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'reach-business-')),store=new OperationStore(join(dir,'ops.sqlite'));t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
 let calls=0;const input={name:'github_read',params:samples.github_read,context:owner,sessionKey:'private-owner',callId:'call',store,reachExecute:async(name)=>{calls++;return normalizeReachResult(good(name),REACH_ACTIONS[name]);}};
 const a=await executeBusinessTool(input),b=await executeBusinessTool({...input,callId:'new-call'});assert.equal(a.details.status,'succeeded');assert.equal(a.details.operationId,b.details.operationId);assert.equal(calls,1);
 const results=await Promise.all(['188888888','188888889'].map(senderId=>executeBusinessTool({...input,sessionKey:'group:'+senderId,context:{...owner,scope:'group',groupId:'700000011',senderId,explicit:true,roleCount:1}})));
 assert.notEqual(results[0].details.operationId,results[1].details.operationId);assert.equal(calls,3);
 const revoked=structuredClone(loadFeatureConfig());revoked.features.xiaohongshu.actions.media.enabled=false;assert.equal(decideFeatureTool(revoked,'xhs_media_workflow',{},owner).allowed,false);
});

test('Reddit public search/read select their backend before execution without failover',()=>{
 for(const tool of ['reddit_search','reddit_read']){const args=reachArgv(tool,samples[tool],60000);assert.equal(args[args.indexOf('--backend')+1],'public-web');}
 assert.equal(reachArgv('reddit_subreddit',samples.reddit_subreddit,60000).includes('--backend'),false);
});

test('Reach backend starts the registered media service without invoking the HTTP backend',async()=>{
 const {startXhsService}=await import('../src/src/features/xhs.js');
 assert.equal(await startXhsService(),true);const {stopXhsService}=await import('../src/src/features/xhs.js');await stopXhsService();
});

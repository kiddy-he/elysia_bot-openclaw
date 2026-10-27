// Operator-only worker. Secret interaction links go directly to configured admin
// private chats, never to stdout, model tools, groups or generic delivery hooks.
import {readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '/root/komachi-xhs-js/src/infra/store.js';
import {SessionStore} from '/root/komachi-xhs-js/src/infra/session.js';
import {HttpBackend} from '/root/komachi-xhs-js/src/backends/http.js';
import {runBrowser} from '/root/komachi-xhs-js/src/browser/runtime.js';
import {loadChromium} from '/root/komachi-xhs-js/src/browser/playwright.js';
import {safeError,XhsError} from '/root/komachi-xhs-js/src/errors.js';
import {loadFeatureConfig,authorizeFeature} from '../src/src/feature-policy.js';
import {resolveOneBotAccount} from '../src/src/config.js';
import {verificationAdmission} from '../src/src/features/xhs-verification.js';
const base='/root/.openclaw';
if(process.env.ONEBOT_CONFIG_ROOT && process.env.ONEBOT_CONFIG_ROOT!==base) throw new XhsError('operator_root_required');
const cfg=JSON.parse(await readFile(join(base,'onebot-xhs.json'),'utf8')),opts=cfg.manualVerification;
if(cfg.enabled!==true||opts?.enabled!==true) throw new XhsError('verification_disabled');
const origin=new URL(opts.publicOrigin);
if(origin.protocol!=='https:'||origin.origin!==opts.publicOrigin||origin.username||origin.password
 ||!Number.isInteger(opts.port)||opts.port<1024||opts.port>65535||!opts.browserPath.startsWith('/'))throw new XhsError('invalid_verification_config');
const root=cfg.dataDir,file=join(root,'manual-verification.json'),sessions=new SessionStore(root),store=new Store(root);
let releaseOperator,releaseSite,noticeTask,notified=false;
const state={id:randomUUID(),status:'starting',createdAt:Date.now(),expiresAt:Date.now()+300000,cooldownUntil:Date.now()+1800000};
const save=async()=>{const temp=`${file}.${process.pid}.tmp`;await writeFile(temp,JSON.stringify(state,null,2),{mode:0o600});await rename(temp,file);};
let policy,account,admins;
async function send(text){
 policy=loadFeatureConfig();
 for(const id of admins){
  if(!policy.identities.adminIds.includes(id)||!policy.accounts.default.privateAdminIds.includes(id))throw new XhsError('verification_revoked');
  const response=await fetch(`${account.httpUrl}/send_private_msg`,{method:'POST',headers:{'Content-Type':'application/json',...(account.accessToken?{Authorization:`Bearer ${account.accessToken}`}:{})},
   body:JSON.stringify({user_id:Number(id),message:[{type:'text',data:{text}}]}),signal:AbortSignal.timeout(15000)});
  const result=await response.json();
  if(!response.ok||result.retcode!==0||result.data?.message_id==null)throw new XhsError('admin_notification_failed');
  state.lastAdminMessageId=String(result.data.message_id);await save();
 }
}
try {
 releaseOperator=store.lock('manual-verification',330000);
 let old;try{old=JSON.parse(await readFile(file,'utf8'));}catch{}
 if(verificationAdmission(old)!=='start')process.exitCode=0;
 else {
  policy=loadFeatureConfig();admins=policy.accounts.default.privateAdminIds.filter(id=>policy.identities.adminIds.includes(id));
  if(!admins.length)throw new XhsError('admin_not_configured');
  for(const line of (await readFile('/root/llbot/secrets/openclaw-onebot.env','utf8')).split('\n')){
   const m=/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);if(m&&m[1]==='ONEBOT_ACCESS_TOKEN'&&!process.env[m[1]])process.env[m[1]]=m[2].replace(/^(['"])(.*)\1$/u,'$2');
  }
  account=resolveOneBotAccount(JSON.parse(await readFile(join(base,'openclaw.json'),'utf8')),'default');
  if(!account.enabled||!account.httpUrl)throw new XhsError('admin_transport_unavailable');
  releaseSite=store.lock('site-account',330000);await save();
  const chromium=await loadChromium();
  const result=await runBrowser({operation:'verify',params:{query:'咖啡'},root,executablePath:opts.browserPath,chromiumSandbox:false,directConnection:true,
   interactionPort:opts.port,interactionPublicOrigin:opts.publicOrigin,deferSessionCommit:true},
   {chromium,emit:event=>{
    if(event.event==='verification_observation'){state.observation={captchaVisible:event.captchaVisible,challengeVisible:event.challengeVisible,loginVisible:event.loginVisible,loggedIn:event.loggedIn};noticeTask=Promise.resolve(noticeTask).then(()=>save());}
    if(event.event==='login_interaction'){
     state.status='waiting_for_verification';state.expiresAt=Date.parse(event.expiresAt);
     noticeTask=(async()=>{await save();await send(`舰长，小红书搜索接口返回461，需要人工检查站点验证。请在约5分钟内打开以下一次性链接：\n${event.interaction_url}\n\n这是现有登录态的远程站点页面。若出现验证码，请手动操作；完成后点击“验证已完成，检查并保存”。请勿转发此链接。若页面没有验证组件，不代表API已恢复。`);notified=true;})().catch(()=>{state.notificationFailed=true;});
    }
   }});
  await noticeTask;
  if(result.result?.human_confirmed!==true||!result.workerSession)throw new XhsError('human_confirmation_missing');
  const beforeCommit=async()=>{
   const fresh=JSON.parse(await readFile(join(base,'onebot-xhs.json'),'utf8'));
   if(!fresh.enabled||fresh.manualVerification?.enabled!==true)throw new XhsError('verification_revoked');
   if(!admins.some(id=>authorizeFeature(loadFeatureConfig(),'xiaohongshu','read',{accountId:'default',senderId:id,scope:'private'}).allowed))throw new XhsError('verification_revoked');
  };
  await sessions.save(result.workerSession,{beforeCommit});state.status='checking';await save();
  const backend=new HttpBackend({sessionStore:sessions});
  try {
   const result=await backend.search({query:'咖啡',limit:1,sort:'relevance',media_type:'image',search_mode:'keyword'},{signal:AbortSignal.timeout(30000)});
   state.status='verified';state.businessVerified=true;state.sampleCount=result.length;state.finishedAt=Date.now();await save();
   await send('舰长，人工操作后的会话已保存，一次低频HTTP搜索复测成功。原先失败的请求不会自动重复发送；之后可以重新发起小红书请求。');
  }catch(error){
   state.status='blocked';state.businessVerified=false;state.error=safeError(error);state.finishedAt=Date.now();await save();
   await send(`舰长，人工操作后的会话已保存，但HTTP搜索仍未恢复（${state.error.code}${state.error.status?`，HTTP ${state.error.status}`:''}）。本次未重试或更换账号，请勿把网页登录成功视为接口恢复。`);
  }finally{await backend.close();}
 }
}catch(error){
 // An already running operator owns its own state and notification.
 if(releaseSite){await noticeTask;state.status='failed';state.error=safeError(error);state.finishedAt=Date.now();await save();
  if(notified)await send(`舰长，本次小红书人工验证任务已结束（${state.error.code}），尚未确认搜索接口恢复。临时链接已失效。`).catch(()=>{});
 }
}finally{releaseSite?.();releaseOperator?.();store.close();}

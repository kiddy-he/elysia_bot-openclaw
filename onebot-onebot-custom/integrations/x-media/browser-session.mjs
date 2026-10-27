#!/usr/bin/env node
// Local administrator operation. Only the isolated X browser's cookies are read;
// cookie values travel through a private file into the adapter, never stdout.
import {readFile,mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
let socket;const pending=new Map();let next=0;
function fail(code){throw Object.assign(new Error(code),{safeCode:code});}
async function rpc(method,params={}){
 const id=++next;
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{pending.delete(id);reject(new Error('cdp_timeout'));},8000);
  pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:e=>{clearTimeout(timer);reject(e);}});
  socket.send(JSON.stringify({id,method,params}));
 });
}
try{
 const action=process.argv[2]??'status';if(!['status','import'].includes(action))fail('usage_status_or_import');
 const response=await fetch('http://127.0.0.1:9227/json/list',{signal:AbortSignal.timeout(3000)});
 if(!response.ok)fail('browser_unavailable');
 const pages=await response.json();
 const page=pages.find(p=>{try{return p.type==='page'&&['x.com','www.x.com','twitter.com','www.twitter.com'].includes(new URL(p.url).hostname);}catch{return false;}});
 if(!page)fail('x_page_not_open');
 const endpoint=new URL(page.webSocketDebuggerUrl);if(endpoint.hostname!=='127.0.0.1'||endpoint.port!=='9227'||endpoint.protocol!=='ws:')fail('invalid_browser_endpoint');
 socket=new WebSocket(endpoint);
 await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
 socket.addEventListener('message',event=>{try{const m=JSON.parse(event.data);const p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.error?p.reject(new Error('cdp_failed')):p.resolve(m.result);}catch{}});
 socket.addEventListener('error',()=>{for(const p of pending.values())p.reject(new Error('browser_disconnected'));pending.clear();});
 const data=await rpc('Network.getCookies',{urls:['https://x.com/','https://twitter.com/']});
 const domains={'x.com':{},'twitter.com':{}};
 for(const c of data.cookies??[]){const host=c.domain?.replace(/^\./u,'');if(['auth_token','ct0'].includes(c.name)&&Object.hasOwn(domains,host)&&typeof c.value==='string'&&c.value)domains[host][c.name]=c.value;}
 const cookies=[domains['x.com'],domains['twitter.com']].find(c=>c.auth_token&&c.ct0)??{};
 const loggedIn=Boolean(cookies.auth_token&&cookies.ct0);
 const status={ok:true,browserReady:true,display:':17',site:new URL(page.url).origin,path:new URL(page.url).pathname,sessionCookiesPresent:loggedIn};
 if(action==='status'){console.log(JSON.stringify(status));}
 else{
  if(!loggedIn)fail('complete_browser_login_first');
  let username=process.argv[3];
  if(!username){
   const result=await rpc('Runtime.evaluate',{expression:"document.querySelector('a[data-testid=\"AppTabBar_Profile_Link\"]')?.getAttribute('href') || ''",returnByValue:true});
   const match=/^\/([A-Za-z0-9_]{1,15})\/?$/u.exec(result.result?.value??'');username=match?.[1];
  }
  if(!username||!/^[A-Za-z0-9_]{1,15}$/u.test(username))fail('username_required_pass_as_third_argument');
  const config=JSON.parse(await readFile('/root/.openclaw/onebot-x.json','utf8'));
  const root='/root/.openclaw/state/x-media';await mkdir(root,{recursive:true,mode:0o700});
  const temp=await mkdtemp(join(root,'browser-import-'));
  try{
   const path=join(temp,'cookies.json');await writeFile(path,JSON.stringify(cookies),{mode:0o600});
   const cli=join(dirname(fileURLToPath(import.meta.url)),'accounts.py');
   const result=await exec(config.python,[cli,'import',config.accountsDb,username,path],{timeout:10000,maxBuffer:65536});
   const imported=JSON.parse(result.stdout);if(imported.ready!==true)fail('session_import_failed');
   console.log(JSON.stringify({ok:true,imported:true,accounts:imported.accounts,active:imported.active,searchNeedsLiveVerification:true}));
  }finally{await rm(temp,{recursive:true,force:true});}
 }
}catch(e){console.log(JSON.stringify({ok:false,error:e.safeCode??'browser_session_unavailable'}));process.exitCode=1;}
finally{socket?.close();}

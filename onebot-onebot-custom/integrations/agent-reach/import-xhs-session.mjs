// Admin-only migration of the existing site's cookies into Reach's own profile.
// Never reads another browser profile or prints credential values.
import {readFile,writeFile} from 'node:fs/promises';
const source='/root/komachi-xhs-js/data/xhs-public/session.json';
const input=JSON.parse(await readFile(source,'utf8'));
const cookies=(input.storageState?.cookies??[]).filter(c=>typeof c.domain==='string'&&(c.domain.replace(/^\./u,'')==='xiaohongshu.com'||c.domain.endsWith('.xiaohongshu.com'))).map(c=>Object.fromEntries(Object.entries(c).filter(([k])=>['name','value','domain','path','expires','httpOnly','secure','sameSite'].includes(k))));
if(!cookies.length)throw Error('No scoped session cookies available');
const info=await(await fetch('http://127.0.0.1:9222/json/version',{signal:AbortSignal.timeout(5000)})).json();
const target=new URL(info.webSocketDebuggerUrl);if(!['127.0.0.1','localhost'].includes(target.hostname)||target.port!=='9222')throw Error('Unexpected browser endpoint');
const socket=new WebSocket(target.href);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
try{await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Cookie import timed out')),5000);socket.addEventListener('message',event=>{const result=JSON.parse(event.data);if(result.id!==1)return;clearTimeout(timer);result.error?reject(Error('Scoped Cookie import failed')):resolve();});socket.send(JSON.stringify({id:1,method:'Storage.setCookies',params:{cookies}}));});console.log(JSON.stringify({ok:true,scopedCookieCount:cookies.length,sourceUpdatedAt:input.updated_at??null}));}finally{socket.close();}

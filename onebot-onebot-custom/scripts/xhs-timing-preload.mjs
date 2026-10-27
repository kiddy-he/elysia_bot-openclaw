// Opt-in timing for isolated real-interface acceptance. Records no request bodies,
// URLs, headers, tokens, user content or downloaded media paths.
import { appendFileSync } from 'node:fs';
import { channel } from 'node:diagnostics_channel';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
const file=process.env.XHS_TIMING_FILE;
if (!file || !process.env.ONEBOT_CONFIG_ROOT?.startsWith('/root/.openclaw/state/xhs-integration-'))
    throw new Error('XHS timing requires an isolated acceptance root');
// Credential providers use a separate Node 20 process. Never import the
// application runtime there or change its protocol.
if (Number(process.versions.node.split('.')[0]) >= 24) {
let sequence=0;
function record(value){appendFileSync(file,JSON.stringify({at:Date.now(),pid:process.pid,...value})+'\n',{mode:0o600});}
function span(kind,operation){const id=`${process.pid}:${++sequence}`,start=Date.now();record({event:'start',id,kind,operation});return extra=>record({event:'end',id,kind,operation,elapsedMs:Date.now()-start,...extra});}
function wrap(target,name,kind,operation=()=>name,extra=()=>({})){
 const original=target[name];
 target[name]=async function(...args){const finish=span(kind,operation(args));try{const value=await original.apply(this,args);finish({ok:value?.ok!==false,...extra(value,args)});return value;}catch(e){finish({ok:false,error:e.code??'error'});throw e;}};
}
const base='/root/.openclaw/extensions/openclaw-onebot/dist/src/';
const [{XhsService,HttpBackend,PublicDownloader},{SerialExecutor},{DeliveryQueue}]=await Promise.all([import(base+'xhs/index.js'),import(base+'features/serial-executor.js'),import(base+'delivery/queue.js')]);
wrap(XhsService.prototype,'execute','xhs-service',args=>args[0],value=>({state:value?.data?.state,error:value?.error?.code,postCount:value?.data?.posts?.length}));
wrap(XhsService.prototype,'runJob','xhs-job',args=>args[0].operation);
wrap(XhsService.prototype,'downloadFile','media-file',args=>args[3],value=>({bytes:value?.bytes,kind:value?.kind}));
for(const name of ['search','inspect','profile','comments'])if(typeof HttpBackend.prototype[name]==='function')wrap(HttpBackend.prototype,name,'xhs-backend');
wrap(PublicDownloader.prototype,'get','media-http',()=> 'get',value=>({bytes:value?.bytes}));
wrap(SerialExecutor.prototype,'acquire','xhs-queue');
for(const method of ['enqueue','dispatchReady'])wrap(DeliveryQueue.prototype,method,'delivery');
function label(path){if(/\/(chat\/completions|responses)(?:\?|$)/u.test(path))return 'llm';if(/^\/api\/sns\//u.test(path))return 'xhs-http';return undefined;}
for(const module of [http,https]){
 const original=module.request;
 module.request=function(...args){
  const first=args[0],opts=first instanceof URL?{path:first.pathname}:typeof first==='string'?{path:new URL(first).pathname}:first;
  const kind=label(opts?.path??'');
  const req=original.apply(this,args);
  if(!kind)return req;
  const finish=span(kind,'request');let done=false;
  req.once('response',res=>{
   record({event:'headers',kind,status:res.statusCode});
   res.once('end',()=>{if(!done){done=true;finish({status:res.statusCode});}});
   res.once('close',()=>{if(!done){done=true;finish({status:res.statusCode,closed:true});}});
  });
  req.once('error',()=>{if(!done){done=true;finish({ok:false});}});
  return req;
 };
}
syncBuiltinESMExports();
const pending=new WeakMap();
channel('undici:request:create').subscribe(({request})=>{const kind=label(request.path??'');if(kind)pending.set(request,{finish:span(kind,'fetch'),kind});});
channel('undici:request:headers').subscribe(({request,response})=>{const entry=pending.get(request);if(entry)record({event:'headers',kind:entry.kind,status:response.statusCode});});
channel('undici:request:trailers').subscribe(({request})=>{pending.get(request)?.finish({ok:true});pending.delete(request);});
channel('undici:request:error').subscribe(({request})=>{pending.get(request)?.finish({ok:false});pending.delete(request);});
record({event:'ready'});

}

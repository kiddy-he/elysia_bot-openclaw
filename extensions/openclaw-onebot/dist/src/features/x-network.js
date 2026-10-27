import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { isIP } from 'node:net';
import { PublicDownloader } from '../xhs/infra/network.js';
import { isPublicAddress } from '../xhs/domain/urls.js';

// Explicit local proxy only. CONNECT targets media IPs already checked below;
// TLS verifies the original hostname. No user-controlled proxy or destination.
export function validateXProxy(value) {
  const u=new URL(value);
  if(u.protocol!=='http:' || !['127.0.0.1','localhost','[::1]'].includes(u.hostname) || !u.port || u.username || u.password || u.pathname!=='/' || u.search || u.hash) throw new Error('invalid X proxy');
  return u;
}
function proxyRequest(proxy) {
  return (options,callback)=>{
    const agent=new https.Agent({keepAlive:false});
    agent.createConnection=(tlsOptions,done)=>{
      const destination=options.family===6?`[${options.hostname}]`:options.hostname;
      const tunnel=http.request({hostname:proxy.hostname.replace(/^\[|\]$/gu,''),port:proxy.port,method:'CONNECT',path:`${destination}:${options.port??443}`,headers:{Host:`${destination}:${options.port??443}`},signal:options.signal});
      let completed=false;
      const finish=(error,socket)=>{if(completed)return;completed=true;done(error,socket);};
      tunnel.on('error',e=>finish(e));
      tunnel.on('connect',(response,socket,head)=>{
        if(response.statusCode!==200 || head.length){socket.destroy();finish(new Error('proxy connect failed'));return;}
        const secure=tls.connect({...tlsOptions,socket,servername:options.servername,rejectUnauthorized:true});
        const abort=()=>secure.destroy();options.signal?.addEventListener('abort',abort,{once:true});
        secure.once('close',()=>options.signal?.removeEventListener('abort',abort));
        secure.once('secureConnect',()=>finish(null,secure));secure.on('error',e=>finish(e));
        if(options.signal?.aborted) secure.destroy();
      });tunnel.end();
    };
    const request=https.request({...options,agent},callback);
    request.once('close',()=>agent.destroy());return request;
  };
}
export function createXDownloader({proxy}={}) {
  if(!proxy) return new PublicDownloader();
  const request=proxyRequest(validateXProxy(proxy)),cache=new Map();
  const lookup=async(host)=>{
    if(isIP(host))return [{address:host,family:isIP(host)}];
    const previous=cache.get(host);if(previous && previous.expires>Date.now())return previous.addresses;
    // Fixed resolver is reached through the administrator's local proxy. Only
    // its answer is used for media CONNECT, avoiding poisoned system DNS.
    const addresses=await new Promise((resolve,reject)=>{
      const req=request({protocol:'https:',hostname:'cloudflare-dns.com',servername:'cloudflare-dns.com',port:443,path:`/dns-query?name=${encodeURIComponent(host)}&type=A`,method:'GET',headers:{Host:'cloudflare-dns.com',Accept:'application/dns-json'},signal:AbortSignal.timeout(8000)},res=>{
        let bytes=0;const chunks=[];
        res.on('data',chunk=>{bytes+=chunk.length;if(bytes>65536)res.destroy(new Error('DNS response too large'));else chunks.push(chunk);});
        res.on('error',reject);res.on('end',()=>{try{
          if(res.statusCode!==200)throw new Error('DNS failed');const data=JSON.parse(Buffer.concat(chunks));
          const values=(data.Answer??[]).filter(a=>a.type===1).map(a=>({address:a.data,family:4}));
          if(!values.length || values.some(a=>!isPublicAddress(a.address)))throw new Error('DNS failed');resolve(values);
        }catch(e){reject(e);}});
      });req.on('error',reject);req.end();
    });
    cache.set(host,{addresses,expires:Date.now()+300000});return addresses;
  };
  return new PublicDownloader({lookup,request});
}

import Ajv from 'ajv';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { onebotPath } from '../paths.js';
import { createXDownloader, validateXProxy } from './x-network.js';

const exec = promisify(execFile);
export const xFail = code => { throw Object.assign(new Error(code), { code }); };
const STOP = new Set(['auth_required','session_invalid','rate_limited','challenge_required','permission_denied','cancelled','deadline_exceeded']);
export function xError(error, signal) {
  if (signal?.aborted) return signal.reason?.name === 'TimeoutError' ? 'deadline_exceeded' : 'cancelled';
  const allowed = new Set([...STOP,'invalid_request','invalid_target','invalid_media_url','metadata_invalid','post_unavailable','no_media','no_matching_posts','album_incomplete','download_size_limit','image_size_limit','video_size_limit','image_decode_failed','video_invalid','download_failed','dns_failed','nonpublic_address','invalid_redirect','permission_denied','authorization_revoked','workflow_busy','delivery_unconfirmed','provider_unavailable','budget_exceeded','too_many_media','invalid_image','invalid_video','download_http_error','incomplete_download']);
  return allowed.has(error?.code) ? error.code : 'provider_unavailable';
}
export const xSchemas = {
  search: {type:'object',additionalProperties:false,required:['query'],properties:{query:{type:'string',minLength:1,maxLength:160},limit:{type:'integer',minimum:1,maximum:20},rank:{enum:['likes','relevance','latest']},media_type:{enum:['auto','image','video']}}},
  inspect: {type:'object',additionalProperties:false,required:['ref_ids'],properties:{ref_ids:{type:'array',minItems:1,maxItems:3,uniqueItems:true,items:{type:'string',maxLength:2000,minLength:1}}}},
  media_workflow: {type:'object',additionalProperties:false,properties:{query:{type:'string',minLength:1,maxLength:160},ref_ids:{type:'array',minItems:1,maxItems:3,uniqueItems:true,items:{type:'string',minLength:1,maxLength:2000}},post_count:{type:'integer',minimum:1,maximum:3},rank:{enum:['likes','relevance','latest']},media_type:{enum:['auto','image','video']}},oneOf:[{required:['query'],not:{required:['ref_ids']}},{required:['ref_ids'],not:{required:['query']}}]},
};
const validators = Object.fromEntries(Object.entries(xSchemas).map(([k,v])=>[k,new Ajv({strict:false}).compile(v)]));
export function validateX(operation, value) {
  if (!validators[operation]?.(value) || value.query !== undefined && (!value.query.trim() || /[\x00-\x1f]/u.test(value.query))) xFail('invalid_request');
  const result=structuredClone(value);
  if(result.query) result.query=result.query.trim();
  if(result.ref_ids) result.ref_ids=result.ref_ids.map(url=>parseXPostUrl(url).url);
  if(result.ref_ids && new Set(result.ref_ids).size!==result.ref_ids.length) xFail('invalid_request');
  return result;
}
export function parseXPostUrl(value) {
  if(typeof value!=='string'||value.length>2000||/[\x00-\x20\x7f\\]/u.test(value)) xFail('invalid_target');
  let u;try{u=new URL(value);}catch{xFail('invalid_target');}
  if (u.protocol!=='https:' || u.username || u.password || u.port || !['x.com','www.x.com','twitter.com','www.twitter.com','mobile.twitter.com','m.twitter.com'].includes(u.hostname)) xFail('invalid_target');
  const match=/^\/(?:[A-Za-z0-9_]{1,15}|i\/web|i)\/status\/([1-9][0-9]{0,24})(?:\/(?:photo|video)\/[1-9][0-9]*)?\/?$/u.exec(u.pathname);
  if(!match) xFail('invalid_target');
  return {id:match[1],url:`https://x.com/i/status/${match[1]}`};
}
export function mediaUrl(value, type) {
  let u;try{u=new URL(value);}catch{xFail('invalid_media_url');}
  if(u.protocol!=='https:' || u.username || u.password || u.port || u.hash || !(type==='image' ? u.hostname==='pbs.twimg.com'&&u.pathname.startsWith('/media/') : u.hostname==='video.twimg.com'&&u.pathname.endsWith('.mp4'))) xFail('invalid_media_url');
  if(type==='image') u.searchParams.set('name','orig');
  return u.href;
}
export const cleanXText = (value,limit=220) => String(value??'').replace(/[\x00-\x1f\x7f]/gu,' ').replace(/\[CQ:/giu,'［CQ：').trim().slice(0,limit);
export function normalizePost(raw, expectedId) {
  const id=String(raw?.id??'');
  if(!/^[1-9][0-9]{0,24}$/u.test(id) || expectedId && id!==expectedId || !Array.isArray(raw.media) || raw.media.length>16) xFail('metadata_invalid');
  const media=raw.media.map(m=>{
    if(!['image','video'].includes(m?.type)) xFail('metadata_invalid');
    return {type:m.type,url:mediaUrl(m.url,m.type)};
  });
  if(new Set(media.map(m=>m.url)).size!==media.length) xFail('metadata_invalid');
  const likes=Number(raw.likes??0);
  return {post_id:id,source_url:`https://x.com/i/status/${id}`,title:cleanXText(raw.text,180)||`${cleanXText(raw.author?.name,40)||'X'} 的帖子`,text:cleanXText(raw.text,2400),author:{name:cleanXText(raw.author?.name,80),username:cleanXText(raw.author?.username,30)},metrics:{likes:Number.isSafeInteger(likes)&&likes>=0?likes:0},media};
}
export const publicXPost = p => ({post_id:p.post_id,source_url:p.source_url,title:p.title,text:p.text,author:p.author,metrics:p.metrics,media_count:p.media.length,media_types:[...new Set(p.media.map(m=>m.type))]});
export function loadXSettings() {
  let c;try{c=JSON.parse(readFileSync(onebotPath('onebot-x.json'),'utf8'));}catch(e){if(e.code==='ENOENT') return {enabled:true,publicLinks:true};throw new Error('invalid X settings');}
  if(c.version!==1 || typeof c.enabled!=='boolean' || typeof c.publicLinks!=='boolean' || Object.keys(c).some(k=>!['version','enabled','publicLinks','python','bridge','accountsDb','proxy'].includes(k)) || ['python','bridge','accountsDb'].some(k=>c[k]!==undefined&&(typeof c[k]!=='string'||!c[k].startsWith('/')||c[k].includes('\0')))) throw new Error('invalid X settings');
  if(c.proxy) validateXProxy(c.proxy);
  return c;
}
const bestVideo = variants => [...(variants??[])].filter(v=>(v.content_type??v.type)==='video/mp4' && typeof v.url==='string').sort((a,b)=>(b.bitrate??0)-(a.bitrate??0))[0]?.url;
export function fromFx(raw, id) {
  const t=raw?.tweet;
  if(raw.code!==200 || !t) xFail(raw.code===429?'rate_limited':[401,403].includes(raw.code)?'permission_denied':'post_unavailable');
  if(String(t.id)!==id) xFail('metadata_invalid');
  let all=t.media?.all;
  if(t.media && !Array.isArray(all)) xFail('metadata_invalid');
  return normalizePost({id:t.id,text:t.text,likes:t.likes,author:{name:t.author?.name,username:t.author?.screen_name},media:(all??[]).map(m=>({type:m.type==='photo'?'image':['video','gif'].includes(m.type)?'video':'unknown',url:m.type==='photo'?m.url:bestVideo(m.variants)??m.url}))},id);
}
export function fromSyndication(t,id) {
  if(String(t?.id_str)!==id || !Array.isArray(t.mediaDetails)) xFail('post_unavailable');
  return normalizePost({id:t.id_str,text:t.text,likes:t.favorite_count,author:{name:t.user?.name,username:t.user?.screen_name},media:t.mediaDetails.map(m=>({type:m.type==='photo'?'image':['video','animated_gif'].includes(m.type)?'video':'unknown',url:m.type==='photo'?m.media_url_https:bestVideo(m.video_info?.variants)}))},id);
}
export class XProvider {
  constructor({config=loadXSettings(),run=exec,downloader=createXDownloader(config)}={}) {Object.assign(this,{config,run,downloader});}
  async bridge(operation,params,signal) {
    signal?.throwIfAborted();
    const c=this.config;
    if(!c.enabled) xFail('permission_denied');
    if(!c.python || !c.bridge || !c.accountsDb) xFail('auth_required');
    let response;
    try {const out=await this.run(c.python,[c.bridge,c.accountsDb],{input:undefined,timeout:40000,maxBuffer:2*1024*1024,signal,env:{PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',X_MEDIA_INPUT:JSON.stringify({operation,...params}),...(c.proxy?{X_MEDIA_PROXY:c.proxy}:{})},shell:false});response=JSON.parse(out.stdout);}
    catch(e){if(signal?.aborted) signal.throwIfAborted();xFail(e?.killed?'deadline_exceeded':'provider_unavailable');}
    if(!response.ok) xFail([...STOP,'album_incomplete','post_unavailable','invalid_request'].includes(response.error)?response.error:'provider_unavailable');
    if(!Array.isArray(response.posts)||response.posts.length>40) xFail('metadata_invalid');
    return response.posts.map(p=>normalizePost(p));
  }
  async search(params,{signal}={}) { return this.bridge('search',params,signal); }
  async inspect(urls,{signal}={}) {
    const ids=urls.map(u=>parseXPostUrl(u).id);
    try {
      const result=await this.bridge('inspect',{ids},signal),map=new Map(result.map(p=>[p.post_id,p]));
      if(result.length!==ids.length || ids.some(id=>!map.has(id))) xFail('post_unavailable');
      return ids.map(id=>map.get(id));
    }catch(e){if(e.code!=='auth_required' || !this.config.publicLinks) throw e;}
    return Promise.all(ids.map(id=>this.publicPost(id,signal)));
  }
  async publicPost(id,signal) {
    const sources=[{url:`https://api.fxtwitter.com/status/${id}`,parse:fromFx,host:'api.fxtwitter.com'},{url:`https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=en&token=0`,parse:fromSyndication,host:'cdn.syndication.twimg.com'}];
    let last;
    for(const source of sources) try {
      signal?.throwIfAborted();
      const r=await this.downloader.get(source.url,{signal,maxBytes:2*1024*1024,timeoutMs:12000,follow:u=>u.protocol==='https:'&&u.hostname===source.host&&!u.port&&!u.username&&!u.password});
      return source.parse(JSON.parse(r.body.toString('utf8')),id);
    } catch(e) {last=e;if(STOP.has(e.code)||signal?.aborted) throw e;}
    xFail(['metadata_invalid','invalid_media_url'].includes(last?.code)?last.code:'post_unavailable');
  }
}

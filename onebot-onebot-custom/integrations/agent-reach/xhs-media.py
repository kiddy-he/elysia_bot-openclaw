#!/usr/bin/env python3
"""Bounded read-only XHS adapter in Reach's owned browser. Never exports cookies."""
import base64
import json
import re
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit, urlencode
from agent_reach.runtime import browser, cdp
from agent_reach.runtime.browser_binding import query_slot, wait_lock

class Failure(Exception):
    def __init__(self, code): self.code = code

def target_url(value, profile=False):
    u = urlsplit(str(value))
    if u.scheme != 'https' or u.username or u.password or u.port not in (None, 443): raise Failure('invalid_target')
    if not profile and u.hostname == 'xhslink.com' and re.fullmatch(r'/[A-Za-z0-9/_-]{1,120}', u.path): return value
    pattern = r'/user/profile/[A-Za-z0-9_-]{8,64}/?' if profile else r'/(?:explore|search_result)/[A-Za-z0-9_-]{8,64}/?'
    if u.hostname not in ('www.xiaohongshu.com','xiaohongshu.com') or not re.fullmatch(pattern,u.path): raise Failure('invalid_target')
    return value

COMMON = r'''
const un=x=>x&&typeof x==='object'?('value' in x?x.value:'_value' in x?x._value:x):x;
const visible=e=>!!e&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;
const text=document.body?.innerText||'';
const dialogs=[...document.querySelectorAll('.captcha-modal-content,.capptch-modal-content-inner')].filter(visible);
const security=dialogs.length>0 || /安全限制|访问链接异常|环境异常/.test(text) || /website-login\/error|error_code=300017|error_code=300031/.test(location.href);
const logged=un(window.__INITIAL_STATE__?.user?.loggedIn)===true;
const loginWall=/登录后查看搜索结果/.test(text)||[...document.querySelectorAll('.login-container')].some(visible);
const gate=security?'challenge_required':loginWall?'login_required':null;
const clean=(v,n=240)=>typeof v==='string'?v.slice(0,n):'';
'''

def evaluate(target, script):
    r=cdp.call('Runtime.evaluate',{'expression':'(() => {'+COMMON+script+'})()','returnByValue':True},target_id=target) or {}
    if r.get('exceptionDetails'): raise Failure('invalid_response')
    return r.get('result',{}).get('value') or {}

SEARCH = r'''
if(gate)return {gate};
const state=window.__INITIAL_STATE__?.search;
const feeds=un(state?.feeds)||un(state?.notes)||[];
let rows=[];
for(const raw of Array.isArray(feeds)?feeds:[]){
 const r=un(raw),c=un(r?.noteCard)||un(r?.note_card);if(!c)continue;
 const id=r.id||c.noteId,token=r.xsecToken||r.xsec_token||c.xsecToken;
 if(!id||!token)continue;
 rows.push({id,xsecToken:token,modelType:'note',noteCard:{type:c.type||'unknown',displayTitle:clean(c.displayTitle||c.display_title||c.title),user:{userId:c.user?.userId||c.user?.user_id,nickname:clean(c.user?.nickname||c.user?.nickName)},interactInfo:{likedCount:c.interactInfo?.likedCount??c.interact_info?.liked_count}},type_status:'source_reported'});
}
if(!rows.length){
 const seen=new Set();
 for(const el of document.querySelectorAll('section.note-item,section')){
  if(!visible(el)||el.classList.contains('query-note-item'))continue;
  const a=el.querySelector('a.cover.mask,a[href*="/search_result/"],a[href*="/explore/"]');if(!a)continue;
  let u;try{u=new URL(a.getAttribute('href'),location.origin)}catch{continue}
  const id=u.pathname.match(/\/(?:search_result|explore)\/([a-zA-Z0-9_-]+)/)?.[1],token=u.searchParams.get('xsec_token');
  if(!id||!token||seen.has(id))continue;seen.add(id);
  const author=el.querySelector('a.author,a[href*="/user/profile/"]');
  rows.push({id,xsecToken:token,modelType:'note',type_status:'candidate',noteCard:{type:el.querySelector('.play-icon,.video-icon,[class*="play-icon"]')?'video':'normal',displayTitle:clean(el.querySelector('.title,.note-title,.footer .title span')?.textContent||a.querySelector('span')?.textContent||''),user:{userId:author?.getAttribute('href')?.match(/\/user\/profile\/([a-zA-Z0-9_-]+)/)?.[1]||'',nickname:clean(author?.querySelector('.name')?.textContent||el.querySelector('.author-name,.nick-name,.name')?.textContent||'')},interactInfo:{likedCount:clean(el.querySelector('.count,.like-count,.like-wrapper .count')?.textContent,64)}}});
 }
}
return {ready:rows.length>0,loggedIn:logged,rows};
'''
INSPECT = r'''
if(gate)return {gate};
const id=location.pathname.match(/\/(?:explore|search_result)\/([a-zA-Z0-9_-]+)/)?.[1];
const map=un(window.__INITIAL_STATE__?.note?.noteDetailMap)||{};const entry=un(map[id]);const n=un(entry?.note)||entry;
if(!n?.type)return {ready:false,loggedIn:logged,notFound:/笔记不存在|笔记已删除|内容不存在/.test(text)};
const video=n.video,streams=video?.media?.stream||{};
const kept={};for(const k of ['h264','EF4'])if(Array.isArray(streams[k]))kept[k]=streams[k].slice(0,16).map(s=>({masterUrl:s.masterUrl,backupUrls:s.backupUrls?.slice(0,3),size:s.size,duration:s.duration,width:s.width,height:s.height,avgBitrate:s.avgBitrate,videoBitrate:s.videoBitrate,format:s.format}));
return {ready:true,loggedIn:logged,source_url:location.href,note:{noteId:n.noteId||id,type:n.type,title:clean(n.title||document.querySelector('#detail-title,.note-content .title')?.textContent||(n.desc?'无标题｜'+n.desc.split('\n')[0].slice(0,80):'')),desc:clean(n.desc,20000),time:n.time,user:{userId:n.user?.userId,nickname:clean(n.user?.nickname||n.user?.nickName,160)},interactInfo:n.interactInfo,tagList:(n.tagList||[]).slice(0,50).map(t=>({id:t.id,name:clean(t.name,160),type:t.type})),imageList:(n.imageList||[]).slice(0,201).map(i=>({urlDefault:i.urlDefault,urlPre:i.urlPre,url:i.url,width:i.width,height:i.height,infoList:(i.infoList||[]).slice(0,12).map(s=>({url:s.url,imageScene:s.imageScene}))})),video:video?{media:{video:{drmType:video.media?.video?.drmType},stream:kept}}:undefined}};
'''
PROFILE = r'''
if(gate)return {gate};const u=window.__INITIAL_STATE__?.user,info=un(u?.userPageData)||{};
const basic=info.basicInfo,inter=info.interactions;
if(!basic)return {ready:false,loggedIn:logged};
const notes=(un(u?.notes)||[]).flat(2);const posts=[];
for(const raw of notes){const c=un(raw),id=c?.noteId||c?.id,token=c?.xsecToken;if(!id||!token)continue;posts.push({post_id:id,source_url:'https://www.xiaohongshu.com/explore/'+id+'?xsec_token='+encodeURIComponent(token),title:clean(c.displayTitle||c.title),note_type:c.type,published_at:null,metrics:{likes:{raw:String(c.interactInfo?.likedCount??''),value:null}},trust:'untrusted_external_sources'});if(posts.length>=20)break;}
return {ready:true,profile:{user_id:location.pathname.split('/').filter(Boolean).pop(),nickname:clean(basic.nickname||basic.nickName,160),bio:clean(basic.desc,2000),interactions:(Array.isArray(inter)?inter:[]).map(i=>({type:clean(i.type,40),name:clean(i.name,80),count:i.count})),posts,coverage:'loaded_public_profile_only',trust:'untrusted_external_sources'}};
'''

def status():
    rows=[]
    for p in cdp._json('/json/list') or []:
        if p.get('type')=='page' and p.get('url','').startswith('https://www.xiaohongshu.com/'):
            rows.append(evaluate(p['id'], 'return {loggedIn:logged,gate};'))
    if any(r.get('gate')=='challenge_required' for r in rows): return {'loggedIn':False,'gate':'challenge_required'}
    return {'loggedIn':any(r.get('loggedIn') for r in rows)}

def page_read(url,script,limit=12):
    existing=status()
    if existing.get('gate'):raise Failure(existing['gate'])
    target=(cdp.call('Target.createTarget',{'url':url,'background':True}) or {}).get('targetId')
    if not target:raise Failure('browser_unavailable')
    preserve=False
    try:
        deadline=time.monotonic()+35;last={};scrolled=0;settled=None
        while time.monotonic()<deadline:
            last=evaluate(target,script)
            if last.get('gate'):
                preserve=True
                raise Failure(last['gate'])
            if last.get('notFound'):raise Failure('not_found')
            if last.get('ready'):
                if last.get('source_url'):target_url(last['source_url'])
                if 'rows' not in last:return last
                settled=settled or time.monotonic()
                if len(last['rows'])>=limit or scrolled>=2 or time.monotonic()-settled>4:return last
                cdp.call('Runtime.evaluate',{'expression':'window.scrollBy(0,900)'},target_id=target);scrolled+=1
            time.sleep(.25)
        raise Failure('login_required' if last.get('loggedIn') is False else 'deadline_exceeded')
    finally:
        if not preserve:cdp.call('Target.closeTarget',{'targetId':target})
        browser.save_session()

def main():
    if len(sys.argv)!=3:raise Failure('invalid_request')
    op=sys.argv[1];args=json.loads(sys.argv[2]);assert isinstance(args,dict)
    browser.ensure_running()
    if op=='status':return status()
    if op=='prepare_login':
        proc=subprocess.run([sys.executable,'/opt/openclaw-agent-reach/prepare-xhs-login.py'],capture_output=True,text=True,timeout=40)
        if proc.returncode:
            if 'already logged in' in proc.stderr:return {'loggedIn':True}
            raise Failure('manual_verification_pending')
        info=json.loads(proc.stdout);image=Path(info['file']).read_bytes()
        return {'kind':info['kind'],'image_base64':base64.b64encode(image).decode(),'expires_seconds':60}
    with query_slot('xiaohongshu'),wait_lock('onebot-xhs-media',wait=10):
        if op=='search':
            q=args.get('query');limit=args.get('limit',12)
            if not isinstance(q,str) or not 1<=len(q)<=300 or type(limit)!=int or not 1<=limit<=30:raise Failure('invalid_request')
            url='https://www.xiaohongshu.com/search_result?'+urlencode({'keyword':q,'source':'web_search_result_notes'})
            return {'rows':page_read(url,SEARCH,limit)['rows'][:limit]}
        if op=='inspect':return page_read(target_url(args.get('target')),INSPECT)
        if op=='profile':return page_read(target_url('https://www.xiaohongshu.com/user/profile/'+str(args.get('user_id')),True),PROFILE)['profile']
        raise Failure('invalid_request')

if __name__=='__main__':
    try:print(json.dumps({'ok':True,'data':main()},ensure_ascii=False))
    except Exception as e:
        print(json.dumps({'ok':False,'error':{'code':getattr(e,'code','adapter_unavailable')}}));sys.exit(1)

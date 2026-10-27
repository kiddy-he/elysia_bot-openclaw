#!/usr/bin/env python3
"""Admin-only QR capture in Reach's own browser, preserving pending challenges."""
import base64
import json
import os
from pathlib import Path
import time
from agent_reach.runtime import browser, cdp

browser.ensure_running()
page = next((t for t in (cdp._json('/json/list') or [])
             if t.get('type') == 'page' and t.get('url', '').startswith('https://www.xiaohongshu.com/')), None)
# A verification dialog may belong to a preserved business tab, not /explore.
for candidate in (cdp._json('/json/list') or []):
    if candidate.get('type')!='page' or not candidate.get('url','').startswith('https://www.xiaohongshu.com/'):continue
    r=cdp.call('Runtime.evaluate', {'expression':"[...document.querySelectorAll('.captcha-modal-content,.capptch-modal-content-inner')].some(e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0)",'returnByValue':True},target_id=candidate['id']) or {}
    if r.get('result',{}).get('value') is True:
        page=candidate
        break
if page:
    target = page['id']
else:
    target = (cdp.call('Target.createTarget', {'url': 'https://www.xiaohongshu.com/explore'}) or {}).get('targetId')
if not target:
    raise SystemExit('Cannot prepare dedicated login page')
# Never reload a page with a pending security challenge. Capture the topmost
# verification QR, rather than the ordinary login QR underneath that dialog.
probe = r'''(() => {
const visible = e => e && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0;
const clip = root => {const r=root.getBoundingClientRect();return {x:Math.max(0,r.x),y:Math.max(0,r.y),width:r.width,height:r.height,scale:1};};
const sms=[...document.querySelectorAll('.capptch-modal-content-inner')].find(e=>visible(e)&&e.querySelector('input[maxlength="6"]'));
if(sms)return {kind:'sms_pending'};
const security=[...document.querySelectorAll('.captcha-modal-content')].find(e=>visible(e)&&e.innerText.includes('扫码验证身份')&&e.querySelector('.qrcode-img'));
if(security){const image=security.querySelector('.qrcode-img');return {kind:'security_verification',expired:security.innerText.includes('已过期'),ready:image.complete&&image.naturalWidth>0,clip:clip(security)};}
const user=window.__INITIAL_STATE__?.user;const flag=user?.loggedIn;const loggedIn=flag&&typeof flag==='object'&&'value' in flag?flag.value:flag;
if(loggedIn===true)return {kind:'already_logged_in'};
const login=[...document.querySelectorAll('.login-container')].find(visible);
const image=login?.querySelector('.qrcode-img');
if(image)return {kind:'login',ready:image.complete&&image.naturalWidth>0,clip:clip(login)};
return {kind:'waiting'};
})()'''
deadline=time.monotonic()+35
refreshed=False
navigated=False
opened=False
state={}
while time.monotonic()<deadline:
    result=cdp.call('Runtime.evaluate', {'expression':probe,'returnByValue':True}, target_id=target) or {}
    state=result.get('result',{}).get('value') or {}
    kind=state.get('kind')
    if kind=='sms_pending':
        raise SystemExit('SMS verification is pending; login QR behind it was not captured')
    if kind=='already_logged_in':
        raise SystemExit('Account is already logged in; no QR refresh needed')
    if kind=='security_verification':
        if state.get('expired'):
            if not refreshed:
                cdp.call('Runtime.evaluate', {'expression':"(document.querySelector('.captcha-modal-content .qr-scan.cursor-pointer') || document.querySelector('.captcha-modal-content .qrcode-container'))?.click()"}, target_id=target)
                refreshed=True
            time.sleep(0.5)
            continue
        if state.get('ready'):
            break
    elif kind=='login':
        # Refresh only an ordinary login page with no active security dialog.
        if not navigated:
            cdp.call('Page.navigate', {'url':'https://www.xiaohongshu.com/explore'}, target_id=target)
            navigated=True
            time.sleep(1)
            continue
        if state.get('ready'):
            break
    elif kind=='waiting' and not opened:
        cdp.call('Runtime.evaluate', {'expression':"(() => {const es=[...document.querySelectorAll('button,a,span,div')].filter(e=>e.textContent.trim()==='登录'&&e.getBoundingClientRect().width>0);(es.find(e=>e.tagName==='BUTTON')||es[es.length-1])?.click();})()"}, target_id=target)
        opened=True
    time.sleep(0.5)
else:
    raise SystemExit('No current QR available; pending login state was preserved')
image=cdp.call('Page.captureScreenshot', {'format':'png','clip':state['clip']}, target_id=target) or {}
if not image.get('data'):
    raise SystemExit('Cannot capture login image')
dest=Path.home()/'.agent-reach'/'login'/'xiaohongshu-login.png'
dest.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
dest.write_bytes(base64.b64decode(image['data']))
os.chmod(dest,0o600)
print(json.dumps({'ok':True,'kind':state['kind'],'file':str(dest),'expires':'short-lived; rerun to refresh'}))

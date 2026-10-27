#!/usr/bin/env python3
"""Bounded read-only twscrape adapter. No credentials in argv/output/model data."""
import asyncio
import json
import os
import sys
from pathlib import Path
from twscrape import API
from twscrape.accounts_pool import NoAccountError
from twscrape.logger import logger

logger.remove()  # upstream HTTP bodies/account errors never enter tool stdout

class Failure(Exception):
    pass

def tweet(t):
    media=[]
    for p in t.media.photos:
        media.append({'type':'image','url':p.url})
    for v in t.media.videos:
        variants=sorted((v for v in v.variants if v.contentType=='video/mp4'),key=lambda x:x.bitrate or 0,reverse=True)
        if not variants:
            raise Failure('album_incomplete')
        media.append({'type':'video','url':variants[0].url})
    for a in t.media.animated:
        if not a.videoUrl:
            raise Failure('album_incomplete')
        media.append({'type':'video','url':a.videoUrl})
    return {'id':str(t.id),'text':t.rawContent,'likes':t.likeCount,'author':{'name':t.user.displayname,'username':t.user.username},'media':media}

async def execute(db, req):
    if not Path(db).is_file():
        raise Failure('auth_required')
    api=API(db,proxy=os.environ.get('X_MEDIA_PROXY'),raise_when_no_account=True,wait_timeout=10,wait_interval=1)
    accounts=await api.pool.accounts_info()
    if not accounts:
        raise Failure('auth_required')
    if not any(a['active'] and a['logged_in'] for a in accounts):
        raise Failure('session_invalid')
    try:
        if req.get('operation')=='search':
            query=req['query']
            kind=req.get('media_type','auto')
            if kind in ('image','video'):
                query+=' filter:'+('images' if kind=='image' else 'videos')
            product='Latest' if req.get('rank')=='latest' else 'Top'
            posts=[]
            async for t in api.search(query,limit=min(int(req.get('limit',20)),20),kv={'product':product}):
                posts.append(tweet(t))
            return posts
        if req.get('operation')=='inspect':
            posts=[]
            for id in req['ids']:
                t=await api.tweet_details(int(id))
                if not t:
                    raise Failure('post_unavailable')
                posts.append(tweet(t))
            return posts
        raise Failure('invalid_request')
    except NoAccountError:
        current=await api.pool.accounts_info()
        raise Failure('rate_limited' if any(a['active'] for a in current) else 'session_invalid')

async def main():
    os.umask(0o077)
    try:
        req=json.loads(os.environ.get('X_MEDIA_INPUT','{}'))
        posts=await asyncio.wait_for(execute(sys.argv[1],req),timeout=35)
        response={'ok':True,'posts':posts}
    except Failure as e:
        response={'ok':False,'error':str(e)}
    except asyncio.TimeoutError:
        response={'ok':False,'error':'deadline_exceeded'}
    except Exception:
        response={'ok':False,'error':'provider_unavailable'}
    print(json.dumps(response,ensure_ascii=False))

if __name__=='__main__':
    asyncio.run(main())

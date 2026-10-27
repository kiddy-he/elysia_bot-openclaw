#!/usr/bin/env python3
"""Local administrator CLI. Cookie values are read only from a private file."""
import asyncio
import json
import os
import stat
import sys
from pathlib import Path
from twscrape import AccountsPool
from twscrape.logger import logger
logger.remove()
async def main():
    os.umask(0o077)
    if len(sys.argv)<3 or sys.argv[1] not in ('status','import'):
        raise ValueError('Usage: accounts.py status DB | import DB USERNAME PRIVATE_COOKIE_JSON')
    action,db=sys.argv[1:3]
    if action=='status' and not Path(db).is_file():
        print(json.dumps({'accounts':0,'active':0,'ready':False}));return
    Path(db).parent.mkdir(parents=True,mode=0o700,exist_ok=True)
    pool=AccountsPool(db)
    if action=='import':
        if len(sys.argv)!=5:
            raise ValueError('Expected DB USERNAME PRIVATE_COOKIE_JSON')
        username,path=sys.argv[3:]
        if not username or len(username)>15 or any(not(c.isalnum() or c=='_') for c in username):
            raise ValueError('Invalid username')
        p=Path(path);s=p.lstat()
        if not stat.S_ISREG(s.st_mode) or s.st_uid!=os.getuid() or s.st_mode&0o077 or s.st_size>65536:
            raise ValueError('Cookie JSON must be an owned regular private file (chmod 600)')
        cookies=json.loads(p.read_text())
        if not isinstance(cookies,dict) or any(not isinstance(cookies.get(k),str) or not cookies[k] for k in ('auth_token','ct0')):
            raise ValueError('Cookie JSON must contain auth_token and ct0')
        await pool.add_account_cookies(username,json.dumps({k:cookies[k] for k in ('auth_token','ct0')}))
        os.chmod(db,0o600)
    accounts=await pool.accounts_info()
    print(json.dumps({'accounts':len(accounts),'active':sum(bool(a['active'] and a['logged_in']) for a in accounts),'ready':any(a['active'] and a['logged_in'] for a in accounts)}))
if __name__=='__main__':
    try:asyncio.run(main())
    except Exception as e:
        print(json.dumps({'ok':False,'error':str(e) if isinstance(e,ValueError) else 'account_setup_failed'}));sys.exit(1)

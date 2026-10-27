// Admin-only, one-time migration of the existing monitor account into the
// isolated read-only video tool. Source ciphertext and monitor stay unchanged.
import{readFile,writeFile,mkdir,chown,chmod}from'node:fs/promises';
import{createDecipheriv,scryptSync}from'node:crypto';
import{execFile}from'node:child_process';import{promisify}from'node:util';
const exec=promisify(execFile),base=new URL('../bilibili-notify/data/secrets/',import.meta.url);
const env=JSON.parse((await exec('/usr/bin/docker',['inspect','--format','{{json .Config.Env}}','openclaw-bilibili-notify'],{maxBuffer:256000})).stdout);
const entry=env.find(line=>line.startsWith('BN_COOKIE_KEY='));if(!entry)throw Error('Existing account encryption key unavailable');
const salt=Buffer.from((await readFile(new URL('kdf.salt',base),'utf8')).trim(),'hex');
const key=scryptSync(entry.slice('BN_COOKIE_KEY='.length).trim(),salt,32,{N:16384,r:8,p:1,maxmem:67108864});
const blob=JSON.parse(await readFile(new URL('cookies.json',base),'utf8')).cookiesJson;
if(blob.v!==2)throw Error('Unsupported session format');
const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(blob.iv,'base64'));decipher.setAuthTag(Buffer.from(blob.tag,'base64'));
const rows=JSON.parse(Buffer.concat([decipher.update(Buffer.from(blob.data,'base64')),decipher.final()]).toString('utf8'));
const cookies=Object.fromEntries(rows.filter(c=>['SESSDATA','bili_jct','ac_time_value','buvid3','buvid4','DedeUserID'].includes(c.key??c.name)).map(c=>[c.key??c.name,c.value]));
if(!cookies.SESSDATA)throw Error('Existing monitor account has no usable credential');
const directory='/var/lib/openclaw-agent-reach/.agent-reach/sessions/bili-cli/.bilibili-cli';await mkdir(directory,{recursive:true,mode:0o700});
const credential={sessdata:cookies.SESSDATA,bili_jct:cookies.bili_jct??'',ac_time_value:cookies.ac_time_value??'',buvid3:cookies.buvid3??'',buvid4:cookies.buvid4??'',dedeuserid:cookies.DedeUserID??'',saved_at:Date.now()/1000};
const uid=Number((await exec('/usr/bin/id',['-u','openclaw-reach'])).stdout.trim());
for(const p of ['/var/lib/openclaw-agent-reach/.agent-reach/sessions','/var/lib/openclaw-agent-reach/.agent-reach/sessions/bili-cli',directory]){await chown(p,uid,uid);await chmod(p,0o700);}
const output=directory+'/credential.json';await writeFile(output,JSON.stringify(credential),{mode:0o600});await chown(output,uid,uid);
console.log(JSON.stringify({ok:true,fieldsCopied:Object.keys(cookies).length,source:'existing-bilibili-monitor-account'}));

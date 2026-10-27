import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run=promisify(execFile);
test('business process executors enforce scopes, approvals and incoming-request dedupe; reminders have a separate local matrix',async()=>{
 const root=await mkdtemp(join(tmpdir(),'onebot-executor-matrix-'));
 try{
  for(const name of ['onebot-features.json','onebot-executors.json','onebot-workspaces.json','onebot-services.json','onebot-delivery.json'])await copyFile((process.env.ONEBOT_CONFIG_ROOT || '/root/.openclaw')+'/'+name,join(root,name));
  const path=join(root,'onebot-features.json'),policy=JSON.parse(await readFile(path));policy.features.bilibili.enabled=true;await writeFile(path,JSON.stringify(policy));
  const result=await run(process.execPath,[new URL('./fixtures/executor-matrix.mjs',import.meta.url).pathname],{env:{...process.env,ONEBOT_CONFIG_ROOT:root},timeout:20000});
  const report=JSON.parse(result.stdout);assert.equal(report.tools,23);assert.equal(report.duplicateExecutions,0);assert.equal(report.realBusinessWrites,0);assert.ok(report.unauthorizedCallsBlocked>=40);
 }finally{await rm(root,{recursive:true,force:true});}
});

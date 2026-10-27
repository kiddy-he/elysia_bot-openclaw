import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run=promisify(execFile);
test('privacy audit tolerates async private labels but rejects a public or unattributed private marker',async()=>{
 const root=await mkdtemp(join(tmpdir(),'simulation-privacy-audit-'));
 const request=(agentId,privateMarkerPresent)=>({scenario:'CASE_CRON_REWARDS',agentScope:'private',privateMarkerPresent,messages:[{role:'system',content:`Runtime: agent=${agentId} | session=agent:${agentId}:test | model=synthetic`} ]});
 try{
  const cases=[...Array.from({length:21},()=>request('public-helper',false)),request('owner',true)];
  await writeFile(join(root,'onebot-workspaces.json'),JSON.stringify({agents:{'public-helper':{scope:'group'},owner:{scope:'private'}}}));
  const path=join(root,'model-calls.json');await writeFile(path,JSON.stringify(cases));
  const args=[new URL('../scripts/audit-simulation.mjs',import.meta.url).pathname,root];
  const report=JSON.parse((await run(process.execPath,args)).stdout);assert.equal(report.passed,true);assert.equal(report.publicRequests,21);assert.equal(report.asynchronousPrivateRequestsWithNextScenarioLabel.length,1);
  await writeFile(path,JSON.stringify([...cases,request('public-helper',true)]));await assert.rejects(run(process.execPath,args));
  await writeFile(path,JSON.stringify([...cases,request('unregistered-agent',true)]));await assert.rejects(run(process.execPath,args));
 }finally{await rm(root,{recursive:true,force:true});}
});

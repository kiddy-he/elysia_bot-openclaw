import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {verificationAdmission} from '../src/src/features/xhs-verification.js';
test('XHS human verification deduplicates active tasks and applies cooldown after every outcome',()=>{
 const now=1000;
 assert.equal(verificationAdmission(undefined,now),'start');
 for(const status of ['starting','waiting_for_verification','checking'])assert.equal(verificationAdmission({status,expiresAt:1001,cooldownUntil:2000},now),'pending');
 for(const status of ['verified','blocked','failed','waiting_for_verification'])assert.equal(verificationAdmission({status,expiresAt:999,cooldownUntil:2000},now),'cooldown');
 assert.equal(verificationAdmission({status:'failed',expiresAt:999,cooldownUntil:999},now),'start');
});
test('isolated roots cannot launch live human verification or expose an operator URL',()=>{
 const source=`import {requestXhsVerification,xhsVerificationPending} from ${JSON.stringify(new URL('../src/src/features/xhs-verification.js',import.meta.url).href)};console.log(JSON.stringify({result:requestXhsVerification(),pending:xhsVerificationPending()}));`;
 const out=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',source],{env:{...process.env,ONEBOT_CONFIG_ROOT:'/tmp/isolated-xhs-verification'},encoding:'utf8'}));
 assert.deepEqual(out,{result:{status:'unavailable'},pending:false});
});

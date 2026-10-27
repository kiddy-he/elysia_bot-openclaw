import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { captureMediaTranscriptTarget, mirrorMediaCompletion } from '../src/src/media-transcript.js';

test('completion captures only the current exact session identity, with no transcript reads or writes',async t=>{
 const root=await mkdtemp(join(tmpdir(),'media-transcript-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'agents/main/agent'),{recursive:true});
 const path=join(root,'agents/main/agent/openclaw-agent.sqlite'),db=new DatabaseSync(path);
 db.exec('CREATE TABLE session_nodes(session_key TEXT PRIMARY KEY,current_session_id TEXT)');db.prepare('INSERT INTO session_nodes VALUES(?,?)').run('agent:main:test','old-session');db.close();
 const target=captureMediaTranscriptTarget({agentId:'main',sessionKey:'agent:main:test'},{root});
 assert.equal(target.sessionId,'old-session');assert.equal(target.storePath,path);
 assert.equal(captureMediaTranscriptTarget({agentId:'../private',sessionKey:'other'},{root}),null);
 assert.equal(captureMediaTranscriptTarget({agentId:'main',sessionKey:'missing'},{root}),null);
 let payload;
 assert.equal(await mirrorMediaCompletion({target,text:'已确认的实际文字',idempotencyKey:'receipt-bound'}, {append:async value=>{payload=value;return {ok:true};}}),true);
 assert.equal(payload.sessionId,'old-session');assert.equal(payload.idempotencyKey,'receipt-bound');assert.equal(payload.text,'已确认的实际文字');
 // A session reset is rejected by the SDK; the plugin must not retry on the new identity.
 let calls=0;
 assert.equal(await mirrorMediaCompletion({target,text:'旧回复',idempotencyKey:'receipt-bound'}, {append:async()=>{calls++;return {ok:false,code:'session-rebound'};}}),false);assert.equal(calls,1);
});
test('missing sessions and mirror errors cannot repeat or invalidate an already delivered reply',async()=>{
 assert.equal(await mirrorMediaCompletion({target:null,text:'文字',idempotencyKey:'id'},{append:async()=>assert.fail('no session')}),false);
 assert.equal(await mirrorMediaCompletion({target:{sessionId:'exact'},text:'文字',idempotencyKey:'id'},{append:async()=>{throw new Error('store unavailable');}}),false);
});

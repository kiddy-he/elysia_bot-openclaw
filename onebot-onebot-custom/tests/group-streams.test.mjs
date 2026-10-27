import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { isolateRoute } from '../src/src/workspaces/routes.js';
import { createStreamLanes, groupStreamKeys } from '../src/src/workspaces/group-streams.js';
import { bindFeatureTurn, trustedFeatureContext, registerFeatureToolGuard } from '../src/src/feature-tools.js';
import { bindTaskProgress, registerTaskProgressHooks } from '../src/src/task-progress.js';

const group = { scope: 'group', conversationId: '700000012', roleAgentId: 'main', mode: 'normal', accountId: 'default' };
const route = senderId => isolateRoute({}, { ...group, senderId });

test('group participants retain stable sessions while accounts, users, roles, modes and groups stay separate', () => {
    const one = route('188888888'), two = route('188888889');
    assert.equal(one.agentId, two.agentId);
    assert.notEqual(one.sessionKey, two.sessionKey);
    assert.equal(one.sessionKey, route('188888888').sessionKey);
    assert.equal(one.mainSessionKey, one.sessionKey);
    const inputs = [group, {...group, accountId:'yuexia'}, {...group, mode:'nsfw'}, {...group, conversationId:'700000011', roleAgentId:'onebot-yuexia'}, {...group, conversationId:'700000011'}];
    assert.equal(new Set(inputs.map(input => isolateRoute({}, {...input,senderId:'188888888'}).sessionKey)).size, inputs.length);
    assert.equal(one.groupSessionKey, isolateRoute({}, {scope:group.scope,conversationId:group.conversationId,roleAgentId:group.roleAgentId}).sessionKey);
    for (const senderId of ['', undefined, '18888:admin', '0', '-188888888']) assert.throws(() => isolateRoute({}, {...group,senderId}));
    assert.throws(() => isolateRoute({}, {...group,senderId:'188888888',accountId:'default:admin'}));
});

test('a slow stream does not hold another participant; same-stream work waits and lanes are released', {timeout:5000}, async () => {
    const lanes = createStreamLanes();
    const a = route('188888888').sessionKey, b = route('188888889').sessionKey;
    const releaseA = await lanes.acquire(a);
    let nextA = false;
    const pendingA = lanes.acquire(a).then(release => { nextA = true; return release; });
    const releaseB = await lanes.acquire(b);
    assert.equal(nextA, false);
    releaseB(); assert.deepEqual(lanes.keys(), [a]);
    releaseA(); releaseA();
    const releaseNextA = await pendingA;
    assert.equal(nextA,true);
    releaseNextA(); assert.deepEqual(lanes.keys(),[]);
});

test('parallel group streams keep tools, actual identities and task progress separate', () => {
    const records = [[], []], contexts = [], releases = [], hooks = {};
    registerFeatureToolGuard({on:(name,fn)=>{if(name==='before_tool_call')hooks.guard=fn;}});
    registerTaskProgressHooks({on:(name,fn)=>{hooks[name]=fn;}});
    try {
        for (const [index,senderId] of ['700000003','188888889'].entries()) {
            const r=route(senderId), context={accountId:'default',senderId,scope:'group',groupId:'700000012',explicit:true,roleCount:1,requestId:`parallel-${index}`,xiaohongshuOperation:true};
            contexts.push({r,context});
            releases.push(bindFeatureTurn(r.sessionKey,context));
            releases.push(bindTaskProgress(r.sessionKey,context,{record:(...args)=>records[index].push(args),hasStep:id=>records[index].some(row=>row[0]===id)}));
        }
        for (const [index,{r,context}] of contexts.entries()) {
            const ctx={sessionKey:r.sessionKey,requester:{accountId:context.accountId,senderId:context.senderId}};
            const event={toolName:'xhs_list_images',params:{},toolCallId:`tool-${index}`};
            assert.equal(hooks.guard(event,ctx),undefined);
            assert.equal(trustedFeatureContext(r.sessionKey).senderId,context.senderId);
            hooks.before_tool_call(event,ctx);
            hooks.after_tool_call({...event,result:{details:{xhs:{ok:true,data:{}}}}},ctx);
            assert.equal(hooks.guard(event,{...ctx,requester:{...ctx.requester,senderId:contexts[1-index].context.senderId}}).block,true);
            // Late/unmatched results and another participant's call ID must not enter this progress tracker.
            hooks.after_tool_call({...event,toolCallId:`tool-${1-index}`},ctx);
            assert(records[index].every(row=>row[0]===`tool-${index}`));
            assert.equal(records[index].length,2);
        }
        releases[0]();
        assert.equal(trustedFeatureContext(contexts[0].r.sessionKey),null);
        assert.equal(trustedFeatureContext(contexts[1].r.sessionKey).senderId,'188888889');
    } finally { for(const release of releases.reverse())release(); }
});

test('group-wide controls enumerate only the selected account, group, role and mode, including active and legacy sessions', async () => {
    const dir=await mkdtemp(join(tmpdir(),'group-stream-keys-'));
    try {
        const databasePath=join(dir,'agent.sqlite'), db=new DatabaseSync(databasePath);
        db.exec('CREATE TABLE session_nodes(session_key TEXT PRIMARY KEY)');
        const one=route('188888888'),two=route('188888889');
        const foreign=[isolateRoute({}, {...group,accountId:'yuexia',senderId:'188888888'}).sessionKey,isolateRoute({}, {...group,mode:'nsfw',senderId:'188888888'}).sessionKey,isolateRoute({}, {...group,conversationId:'700000011',senderId:'188888888'}).sessionKey,`${one.sessionKey}:spoof`];
        for(const key of [one.groupSessionKey,one.sessionKey,...foreign])db.prepare('INSERT INTO session_nodes VALUES(?)').run(key);
        db.close();
        assert.deepEqual(new Set(groupStreamKeys(one.groupSessionKey,'default',{databasePath,activeKeys:[two.sessionKey,...foreign]})),new Set([one.groupSessionKey,one.sessionKey,two.sessionKey]));
        assert.throws(()=>groupStreamKeys('agent:main:onebot:private:188888888','default',{databasePath}));
        assert.deepEqual(groupStreamKeys(one.groupSessionKey,'default',{databasePath:join(dir,'absent.sqlite')}),[]);
        assert.deepEqual(groupStreamKeys(one.groupSessionKey,'default',{databasePath:join(dir,'absent.sqlite'),activeKeys:[two.sessionKey]}),[two.sessionKey]);
    } finally { await rm(dir,{recursive:true,force:true}); }
});

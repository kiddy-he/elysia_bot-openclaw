import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { scopedAgent, helperAgent, isolateRoute, loadWorkspaceRoutes, canonicalAgentId } from '../src/src/workspaces/routes.js';
const routes = loadWorkspaceRoutes();
const config = JSON.parse(readFileSync('/root/.openclaw/openclaw.json', 'utf8'));
test('groups, roles and modes use distinct agents/workspaces and clean session keys', () => {
    const inputs = [ ['700000011', 'main', 'normal'], ['700000011', 'onebot-yuexia', 'normal'], ['700000008', 'main', 'normal'], ['700000011', 'main', 'nsfw'] ];
    const results = inputs.map(([conversationId, roleAgentId, mode]) => isolateRoute({}, { scope: 'group', conversationId, roleAgentId, mode }));
    assert.equal(new Set(results.map(route => route.agentId)).size, inputs.length);
    assert.equal(new Set(results.map(route => config.agents.entries[route.agentId].workspace)).size, inputs.length);
    assert.ok(results.every(route => route.sessionKey.includes(`agent:${route.agentId}:onebot:group:`)));
    assert.throws(() => scopedAgent({ scope: 'group', conversationId: '123456789', roleAgentId: 'main' }));
});
test('all group helpers remain in their originating workspace and cannot use host tools', () => {
    for (const [id, info] of Object.entries(routes.agents)) {
        if (!['group', 'visitor', 'automation'].includes(info.scope)) continue;
        const entry = config.agents.entries[id]; assert.equal(entry.workspace, info.workspace); assert.equal(entry.memory.search.enabled, false); assert.deepEqual(entry.skills, info.accountId === 'default' && (info.purpose === 'main' || info.scope === 'automation') ? ['elysia-tts'] : []); assert.equal(entry.heartbeat, undefined);
        for (const purpose of ['peer', 'review', 'fallback', 'rewrite', 'vision']) {
            const helper = config.agents.entries[helperAgent(id, purpose)];
            assert.equal(helper.workspace, entry.workspace);
            if (info.accountId === 'default' && (info.scope === 'automation' || info.scope === 'visitor')) {
                assert.equal(helper.tools.allow, undefined); assert.equal(helper.tools.alsoAllow, undefined);
                assert.deepEqual(helper.tools.deny, ['group:openclaw', 'group:fs', 'group:runtime', 'group:ui', 'transcripts', 'openclaw']);
            }
            else assert.deepEqual(helper.tools.deny, ['*']);
        }
        if (info.scope === 'group' && info.purpose === 'main') { assert.equal(entry.tools.allow, undefined); assert.ok(entry.tools.deny.includes('group:openclaw')); assert.ok(entry.tools.deny.includes('group:fs')); assert.ok(entry.tools.deny.includes('group:runtime')); }
        assert.equal(canonicalAgentId(id), info.baseAgentId);
    }
});
test('public workspaces contain only reviewed persona and fresh context, no private memory links', () => {
    const paths = new Set(Object.values(routes.agents).filter(info => info.scope !== 'private').map(info => info.workspace));
    for (const path of paths) {
        assert.ok(!existsSync(`${path}/MEMORY.md`)); assert.ok(!existsSync(`${path}/memory`));
        const agents = readFileSync(`${path}/AGENTS.md`, 'utf8'); assert.match(agents, /禁止读取私聊工作区/u);
        assert.ok(!readdirSync(path, { withFileTypes: true }).some(file => file.isSymbolicLink()));
        assert.doesNotMatch(readFileSync(`${path}/USER.md`, 'utf8'), /700000003|舰长/u);
    }
    assert.equal(config.agents.entries.main.workspace, undefined); // owner history remains at the original default
});
test('visitors have distinct per-user sessions and no group/private helper crossover', () => {
    const one = isolateRoute({}, { scope: 'visitor', conversationId: '11111111', roleAgentId: 'main' });
    const two = isolateRoute({}, { scope: 'visitor', conversationId: '22222222', roleAgentId: 'main' });
    assert.equal(one.agentId, two.agentId); assert.notEqual(one.sessionKey, two.sessionKey);
    assert.notEqual(helperAgent(one.agentId, 'fallback'), helperAgent('main', 'fallback'));
});

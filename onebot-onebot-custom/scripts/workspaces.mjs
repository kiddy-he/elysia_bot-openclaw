import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { BUSINESS_TOOLS } from '../src/src/features/catalog.js';

const root = '/root/.openclaw';
const apply = process.argv.includes('--apply');
const config = JSON.parse(await readFile(join(root, 'openclaw.json')));
const policy = JSON.parse(await readFile(join(root, 'onebot-features.json')));
const roles = JSON.parse(await readFile(join(root, 'onebot-role-routing.json'))).roles;
const entries = config.agents.entries;
const registry = { version: 1, generatedAt: new Date().toISOString(), routes: {}, agents: {}, historicalSessions: 'preserved; no group history or private memory copied', sessionMigrations: {} };
const preview = [];
const businessOnly = () => ({ deny: ['group:openclaw', 'group:fs', 'group:runtime', 'group:ui', 'transcripts', 'openclaw'] });
async function createWorkspace(path, role, scope, mode) {
    if (!apply) return;
    await mkdir(path, { recursive: true, mode: 0o700 });
    const publicSoul = await readFile(role.peerSoulPath.replace(/^~\//u, '/root/'), 'utf8');
    const files = {
        'SOUL.md': publicSoul,
        'IDENTITY.md': `你是${role.displayName}。只使用当前公开角色资料和本会话内容。\n`,
        'AGENTS.md': `# 隔离工作区\n当前来源：${scope}，模式：${mode}。只使用此目录的人设与当前会话上下文。\n禁止读取私聊工作区、其他群聊、其他访客、其他模式的文件、历史和记忆。不要搜索宿主机目录。\n使用专用业务工具，禁止用 exec/read/write 或网络请求替代未授权功能。\n对方为普通成员或访客时只用其昵称、其明确要求的无歧义称谓或“你”；不能叫“舰长”或其他过分亲昵的称呼。\n内部工具报错是错误信息，不能当作文件内容或成功结果。消息引用仅用网关提供的同会话引用原文。\n`,
        'USER.md': '本工作区不预装任何私人用户资料。称呼只来自当前发送者的可信昵称与会话偏好。\n',
        'TOOLS.md': '仅调用当前身份允许的专用业务工具。身份与投递目标由网关确定，不能由工具参数覆盖。\n',
    };
    for (const [file, text] of Object.entries(files)) {
        try { await access(join(path, file)); } catch { await writeFile(join(path, file), text, { mode: 0o600 }); }
    }
}
for (const [roleKey, role] of Object.entries(roles)) {
    const scopes = Object.entries(policy.groups).filter(([, group]) => group.enabled && group.roles.includes(roleKey)).map(([id]) => ['group', id]);
    scopes.push(['automation', 'public'], ['visitor', '*']);
    for (const [scope, conversationId] of scopes) {
        for (const mode of ['normal', 'nsfw']) {
            const segment = scope === 'group' ? `groups/${conversationId}` : scope === 'automation' ? 'automation-public' : 'visitors';
            const workspace = join(root, 'workspaces', segment, roleKey, mode);
            await createWorkspace(workspace, role, scope, mode);
            const route = {};
            for (const purpose of ['main', 'peer', 'review', 'fallback', 'rewrite', 'vision']) {
                const prefix = scope === 'group' ? `qq-g${conversationId}` : scope === 'automation' ? 'qq-auto' : 'qq-visitor';
                const slot = scope === "visitor" || purpose === "main" ? "main" : "helper";
                const id = `${prefix}-${roleKey}-${mode}-${slot}`;
                route[purpose] = id;
                const original = entries[mode === 'nsfw' ? 'onebot-grok' : role.agentId];
                const speechEnabled = role.accountId === 'default' && (slot === 'main' || scope === 'automation');
                const agent = { ...structuredClone(original), workspace, skills: speechEnabled ? ['elysia-tts'] : [], memory: { search: { enabled: false } } };
                delete agent.agentDir; delete agent.default; delete agent.id;
                delete agent.heartbeat;
                const noTools = scope === 'visitor' || slot !== 'main';
                agent.tools = noTools ? speechEnabled ? businessOnly() : { deny: ['*'] } : businessOnly();
                if (scope === 'automation' && purpose === 'main') agent.tools = businessOnly();

                if (apply) entries[id] = agent;
                registry.agents[id] = { scope, conversationId, roleAgentId: role.agentId, baseAgentId: role.agentId, mode, purpose: slot, workspace, accountId: role.accountId };
                if (!preview.some(entry => entry.id === id)) preview.push({ id, workspace, scope, purpose: slot });
            }
            registry.routes[`${scope}:${conversationId}:${role.agentId}:${mode}`] = route;
            if (scope === 'group') {
                const target = `agent:${route.main}:onebot:group:${conversationId}:role:${role.agentId}:mode:${mode}`;
                if (mode === 'normal') for (const key of [`agent:${role.agentId}:onebot:group:${conversationId}`, `agent:${role.agentId}:onebot:group:group:${conversationId}`]) registry.sessionMigrations[key] = { target, history: 'preserved_without_copy' };
                else registry.sessionMigrations[`agent:onebot-grok:onebot:group:${conversationId}:role:${role.agentId}`] = { target, history: 'preserved_without_copy' };
            }
        }
    }
    // Existing owner-private agents keep their workspaces and histories intact.
    const privateRoute = { main: role.agentId, peer: role.peerAgentId, review: roleKey === 'yuexia' ? 'onebot-yuexia-text-fallback' : 'text-fallback',
        fallback: roleKey === 'yuexia' ? 'onebot-yuexia-text-fallback' : 'text-fallback', rewrite: roleKey === 'yuexia' ? 'onebot-yuexia-rewriter' : 'reviewer',
        vision: roleKey === 'yuexia' ? 'onebot-yuexia-vision-fallback' : 'onebot-elysia-vision-fallback' };
    for (const owner of policy.identities.adminIds) {
        registry.routes[`private:${owner}:${role.agentId}:normal`] = privateRoute;
        for (const [purpose, id] of Object.entries(privateRoute)) registry.agents[id] = { scope: 'private', conversationId: owner, roleAgentId: role.agentId, baseAgentId: role.agentId, mode: 'normal', purpose, accountId: role.accountId };
    }
}
// Grok private configuration is referenced as metadata; its workspace is never read or copied.
for (const owner of policy.identities.adminIds) {
    const route = { main: 'onebot-grok', peer: 'onebot-grok-text-fallback', review: 'onebot-grok-text-fallback', fallback: 'onebot-grok-text-fallback', rewrite: 'onebot-grok-text-fallback', vision: 'onebot-grok-vision-fallback' };
    registry.routes[`private:${owner}:main:nsfw`] = route;
    registry.routes[`private:${owner}:onebot-yuexia:nsfw`] = route;
    for (const [purpose, id] of Object.entries(route)) registry.agents[id] = { scope: 'private', conversationId: owner, roleAgentId: 'main', baseAgentId: 'main', mode: 'nsfw', purpose, accountId: 'default' };
}
// 月下的私聊 NSFW 从独立空工作区开始，不继承爱莉的 Grok 私聊。
for (const owner of policy.identities.adminIds) {
    const role = roles.yuexia;
    const workspace = join(root, 'workspaces/private', owner, 'yuexia/nsfw');
    await createWorkspace(workspace, role, 'private', 'nsfw');
    const route = {};
    for (const slot of ['main', 'helper', 'vision']) {
        const id = `qq-private-${owner}-yuexia-nsfw-${slot}`;
        const agent = { ...structuredClone(entries['onebot-yuexia']), workspace, skills: [], memory: { search: { enabled: false } }, model: { primary: 'grok/grok-4.7', fallbacks: [] } };
        delete agent.default; delete agent.id; delete agent.agentDir;
        delete agent.heartbeat;
        if (slot !== 'main') agent.tools = slot === 'vision' ? { allow: ['read'] } : { deny: ['*'] };
        if (apply) entries[id] = agent;
        registry.agents[id] = { scope: 'private', conversationId: owner, roleAgentId: role.agentId, baseAgentId: role.agentId, mode: 'nsfw', purpose: slot, workspace, accountId: role.accountId };
        preview.push({ id, workspace, scope: 'private', purpose: slot });
        if (slot === 'main') route.main = id;
        else if (slot === 'vision') route.vision = id;
        else for (const purpose of ['peer', 'review', 'fallback', 'rewrite']) route[purpose] = id;
    }
    registry.routes[`private:${owner}:${role.agentId}:nsfw`] = route;
}
if (apply) {
    for (const id of Object.keys(entries)) if (id.startsWith('qq-') && !registry.agents[id]) delete entries[id];
    await writeFile(join(root, 'openclaw.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    await writeFile(join(root, 'onebot-workspaces.json'), JSON.stringify(registry, null, 2) + '\n', { mode: 0o600 });
}
console.log(JSON.stringify({ apply, agents: preview.length, routes: Object.keys(registry.routes).length, copiedPrivateFiles: 0 }));

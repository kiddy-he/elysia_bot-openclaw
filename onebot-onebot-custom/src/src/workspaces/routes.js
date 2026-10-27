import { onebotPath } from '../paths.js';
import { readFileSync, statSync } from 'node:fs';
const path = onebotPath('onebot-workspaces.json');
let cache, fingerprint;
export function loadWorkspaceRoutes() {
    const st = statSync(path);
    const next = `${st.mtimeMs}:${st.size}`;
    if (next !== fingerprint) {
        const value = JSON.parse(readFileSync(path, 'utf8'));
        if (value.version !== 1 || !value.agents || !value.routes) throw new Error('invalid workspace routing');
        cache = value; fingerprint = next;
    }
    return cache;
}
export function canonicalAgentId(id, config = loadWorkspaceRoutes()) { return config.agents[id]?.baseAgentId ?? id; }
export function scopedAgent({ scope, conversationId, roleAgentId, mode = 'normal', purpose = 'main' }, config = loadWorkspaceRoutes()) {
    const role = canonicalAgentId(roleAgentId, config);
    const key = `${scope}:${scope === 'visitor' ? '*' : conversationId}:${role}:${mode}`;
    const id = config.routes[key]?.[purpose];
    if (!id || !config.agents[id]) throw new Error(`missing isolated agent route: ${key}:${purpose}`);
    return id;
}
export function helperAgent(agentId, purpose, config = loadWorkspaceRoutes()) {
    const info = config.agents[agentId];
    if (!info) throw new Error(`unregistered workspace agent: ${agentId}`);
    return scopedAgent({ ...info, purpose }, config);
}
export function isolateRoute(route, { scope, conversationId, roleAgentId, mode = 'normal', purpose = 'main', accountId, senderId }, config = loadWorkspaceRoutes()) {
    const id = scopedAgent({ scope, conversationId, roleAgentId, mode, purpose }, config);
    const sessionKey = `agent:${id}:onebot:${scope === 'group' ? 'group' : 'direct:private'}:${conversationId}:role:${canonicalAgentId(roleAgentId, config)}:mode:${mode}`;
    // A group workspace/persona is shared; mutable model/tool state is not.
    // IDs come only from the trusted OneBot envelope, never from model arguments.
    const participant = scope === 'group' && (accountId !== undefined || senderId !== undefined);
    if (participant && (!/^[A-Za-z0-9_-]{1,64}$/u.test(String(accountId ?? '')) || !/^[1-9][0-9]{4,19}$/u.test(String(senderId ?? ''))))
        throw new Error('invalid group stream identity');
    const streamKey = participant ? `${sessionKey}:account:${accountId}:sender:${senderId}` : sessionKey;
    return { ...route, agentId: id, sessionKey: streamKey, mainSessionKey: streamKey, lastRoutePolicy: 'session', conversationMode: mode,
        ...(participant ? { groupSessionKey: sessionKey, streamOwnerId: String(senderId) } : {}) };
}

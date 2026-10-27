import { randomUUID } from 'node:crypto';

// Ephemeral by design: a progress message left in a durable queue after a
// restart must not outlive the task which produced it.
const active = new Map();
const contextKey = c => c?.requestId ? JSON.stringify([c.accountId,c.scope,String(c.groupId ?? ''),String(c.senderId),String(c.requestId)]) : null;
export function createProgressToken(context) { const token = randomUUID(); active.set(token,contextKey(context)); return token; }
export function currentProgressToken(token) { return typeof token === 'string' && active.has(token); }
export function closeProgressToken(token) { active.delete(token); }

export function closeProgressForContext(context) { const key=contextKey(context); if(key) for(const [token,owner] of active) if(owner===key) active.delete(token); }

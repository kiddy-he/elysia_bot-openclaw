import { currentProgressToken, closeProgressForContext } from '../progress-state.js';
import { onebotPath } from '../paths.js';
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile, realpath, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { authorizeFeature, loadFeatureConfig, outboundTargetAllowed, automationFeatureEnabled } from '../feature-policy.js';
import { canonical, digest, operationStore } from '../access/operations.js';
import { deliverySettings } from './limiter.js';
import { loadServiceRegistry } from '../access/services.js';
import { authorizeReminderDelivery } from '../features/reminders.js';

const lanes = new Map();
// Managed media survives temporary-source cleanup and is accepted by the core
// reply normalizer; the operation ledger still binds it to the actual request.
const artifactRoot = onebotPath('media/outbound/onebot');
export function authorizeDelivery(request, policy = loadFeatureConfig(), { bilibiliConfig, store } = {}) {
    const { accountId, target, feature, action, context, originJobId } = request;
    if (request.parts?.some(part => part.type === 'forward')) {
        if (!['xiaohongshu','x'].includes(feature) || action !== 'media' || !context || context.internal || context.actorType === 'service'
            || !['private','group'].includes(context.scope) || target?.type !== context.scope || context.accountId !== accountId
            || !context.requestId || !/^[1-9][0-9]{4,19}$/u.test(String(context.senderId))
            || String(context.scope === 'group' ? context.groupId : context.senderId) !== String(target.id)
            || request.parts.length !== 1) throw new Error('invalid forward grant');
        const part=request.parts[0];
        if (Object.keys(part).some(key => !['type','nodes'].includes(key)) || !Array.isArray(part.nodes) || !part.nodes.length || part.nodes.length>64
            || part.nodes.reduce((n,node)=>n+(node?.media?.length??0),0)>160
            || part.nodes.some(node => !node || Object.keys(node).some(key=>!['title','media'].includes(key)) || !Array.isArray(node.media) || !node.media.length || node.media.length>160
                || node.title !== undefined && (typeof node.title !== 'string' || !node.title.trim() || node.title.length > 240)
                || node.media.some(item=>!item || !['image','video'].includes(item.type) || typeof item.path!=='string' || Object.keys(item).some(key=>!['type','path'].includes(key))))) throw new Error('invalid forward batch');
    }
    if (!target || !['group', 'private'].includes(target.type) || !/^[1-9][0-9]{4,19}$/u.test(String(target.id))) throw new Error('invalid destination');
    if (!outboundTargetAllowed(policy, accountId, target.type, target.id)) throw new Error('destination revoked');
    if (!policy.features[feature]?.actions[action]?.enabled || !policy.features[feature].enabled) throw new Error('feature disabled');
    if (!policy.features[feature].accountIds.includes(accountId) || (target.type === 'group' && !policy.features[feature].groupIds.includes(String(target.id)))) throw new Error('destination outside feature');
    if (request.reminderId || feature === 'reminders' || request.parts?.some(p => p.mentions !== undefined)) {
        if (feature !== 'reminders' || action !== 'create' || !request.reminderId) throw new Error('mentions require a registered reminder');
        authorizeReminderDelivery(request, policy, store);
    }
    if (request.speechService) {
        const subject = loadServiceRegistry().jobs[originJobId];
        if (!originJobId || !automationFeatureEnabled(policy, 'conversation', 'media', accountId)
            || subject?.speechTarget?.type !== target.type || String(subject.speechTarget.id) !== String(target.id)
            || request.workspaceAgentId !== subject.agentId || request.parts?.length !== 1 || request.parts[0].type !== 'record')
            throw new Error('scheduled speech grant revoked');
    }
    if (request.scriptService === 'qzone-daily') {
        if (feature !== 'qzone' || action !== 'publish' || accountId !== 'default' || target.type !== 'private'
            || !policy.accounts.default.privateAdminIds.includes(String(target.id))
            || request.originJobId !== '4b13a241-07de-57bb-8d55-7c7fb958b5f3'
            || request.parts?.length !== 1 || request.parts[0].type !== 'text'
            || typeof request.parts[0].text !== 'string' || request.parts[0].text.length > 2000)
            throw new Error('Qzone daily notification grant revoked');
    } else if (request.scriptService && (!['alas-monitor', 'alas-screenshot'].includes(request.scriptService) || feature !== 'alas' || accountId !== 'default'
        || action !== (request.scriptService === 'alas-monitor' ? 'control' : 'screenshot') || target.type !== 'private' || !policy.accounts.default.privateAdminIds.includes(String(target.id)))) throw new Error('script service grant revoked');
    if (request.bilibiliRoute) {
        const config = bilibiliConfig ?? JSON.parse(readFileSync(onebotPath('onebot-bilibili.json'), 'utf8'));
        const route = config.routes?.find(route => route.targetId === request.bilibiliRoute && route.enabled);
        if (!config.enabled || !route || feature !== 'bilibili' || action !== 'read' || route.accountId !== accountId || target.type !== 'group' || route.groupId !== String(target.id)) throw new Error('Bilibili service grant revoked');
    } else if (originJobId) {
        const binding = policy.automationBindings[originJobId];
        const subject = loadServiceRegistry().jobs[originJobId];
        if (!subject || (subject.accountId && subject.accountId !== accountId)) throw new Error('service account grant revoked');
        if (!binding?.enabled || binding.feature !== feature || !automationFeatureEnabled(policy, feature, action, accountId)
            || (target.type === 'group' && !binding.deliveryGroupIds.includes(String(target.id)))) throw new Error('service grant revoked');
    } else if (context && !authorizeFeature(policy, feature, action, context).allowed) throw new Error('actor permission revoked');
    return true;
}
export async function persistArtifact(path, store = operationStore(), root = artifactRoot) {
    const resolved = await realpath(path);
    const info = await stat(resolved);
    if (!info.isFile() || info.size > 25 * 1024 * 1024) throw new Error('invalid artifact');
    const bytes = await readFile(resolved);
    const hash = createHash('sha256').update(bytes).digest('hex');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const destination = join(root, hash + (/^\.[a-zA-Z0-9]{1,8}$/u.test(extname(path)) ? extname(path).toLowerCase() : '.bin'));
    await writeFile(destination, bytes, { mode: 0o600, flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    store.db.prepare('INSERT OR IGNORE INTO artifacts VALUES(?,?,?,?)').run(hash, destination, bytes.length, Date.now());
    return destination;
}
const nativeSender = async params => (await import('openclaw/plugin-sdk/channel-outbound')).sendDurableMessageBatch(params);

export class DeliveryQueue {
    constructor({ store = operationStore(), send = nativeSender, policy = loadFeatureConfig, config = async () => JSON.parse(await readFile(process.env.OPENCLAW_CONFIG_PATH || onebotPath('openclaw.json'), 'utf8')) } = {}) {
        Object.assign(this, { store, send, policy, config });
    }
    get(id) { return this.store.db.prepare('SELECT * FROM deliveries WHERE id=?').get(id); }
    async enqueue(input, { signal } = {}) {
        signal?.throwIfAborted();
        const request = structuredClone(input);
        request.expiresAt ??= Date.now() + deliverySettings().defaultTtlMs;
        authorizeDelivery(request, this.policy(), { store: this.store });
        const dedupe = request.dedupeKey ?? randomUUID();
        const id = `onebot-${digest({ dedupe, accountId: request.accountId, target: request.target })}`;
        for (const part of request.parts ?? []) {
            signal?.throwIfAborted();
            if (part.path) part.path = await persistArtifact(part.path, this.store);
            if (part.type === 'forward') {
                if (!['xiaohongshu','x'].includes(request.feature) || request.action !== 'media' || !Array.isArray(part.nodes) || !part.nodes.length || part.nodes.length > 64) throw new Error('invalid forward batch');
                let totalBytes=0;
                for (const node of part.nodes) for (const media of node.media) {
                    signal?.throwIfAborted();
                    media.path=await persistArtifact(media.path,this.store);
                    totalBytes+=(await stat(media.path)).size;
                    if (totalBytes>100*1024*1024) throw new Error('forward batch exceeds 100MiB');
                }
            }
        }
        if (!request.parts?.length || request.parts.length > 64) throw new Error('invalid message parts');
        for (const part of request.parts) {
            if (!['text', 'image', 'record', 'file','forward'].includes(part.type) || (part.type === 'text' ? typeof part.text !== 'string' || !part.text || part.text.length > 4500 : part.type === 'forward' ? !part.nodes?.length : !part.path)) throw new Error('invalid part');
            if (part.caption !== undefined && (part.type !== 'image' || typeof part.caption !== 'string' || !part.caption.trim() || part.caption.length > 4500)) throw new Error('invalid image caption');
            if (part.mentions !== undefined && (request.feature !== 'reminders' || part.type !== 'text' || request.target.type !== 'group'
                || !Array.isArray(part.mentions) || part.mentions.length !== 1 || !/^[1-9][0-9]{4,19}$/u.test(String(part.mentions[0])))) throw new Error('invalid reminder mention');
        }
        signal?.throwIfAborted();
        this.store.transaction(() => {
            const previous = this.get(id);
            if (previous) {
                const existing = JSON.parse(previous.request);
                const comparable = value => { const clone = structuredClone(value); delete clone.expiresAt; return canonical(clone); };
                if (comparable(existing) !== comparable(request)) throw new Error('delivery dedupe identity conflict');
                return;
            }
            this.store.db.prepare('INSERT INTO deliveries VALUES(?,?,?,?,?,NULL,NULL,?,?)').run(id, dedupe, request.operationId ?? null, canonical(request), request.approvalIds?.length ? 'waiting_approval' : 'ready', Date.now(), Date.now());
            for (const approval of request.approvalIds ?? []) this.store.db.prepare('INSERT INTO dependencies VALUES(?,?,0)').run(id, approval);
        });
        return this.dispatch(id, { signal });
    }
    async dispatch(id, { signal } = {}) {
        const row = this.get(id);
        if (!row) throw new Error('unknown delivery');
        if (row.state === 'accepted') return { id, state: row.state, receipt: JSON.parse(row.receipt) };
        if (!['ready', 'waiting_approval'].includes(row.state)) return { id, state: row.state };
        if (this.store.db.prepare('SELECT COUNT(*) AS n FROM dependencies WHERE delivery_id=? AND resolved=0').get(id).n) return { id, state: 'waiting_approval' };
        const request = JSON.parse(row.request);
        const lane = `${request.accountId}:${request.target.type}:${request.target.id}`;
        const previous = lanes.get(lane) ?? Promise.resolve();
        const work = previous.catch(() => {}).then(() => {
            if (signal?.aborted) {
                const state=this.get(id).state;
                if (['ready','waiting_approval'].includes(state)) { this.set(id,'cancelled',{reason:'producer cancelled before dispatch'});return {id,state:'cancelled'}; }
                return {id,state};
            }
            return this.dispatchReady(id, request);
        });
        lanes.set(lane, work);
        try { return await work; } finally { if (lanes.get(lane) === work) lanes.delete(lane); }
    }
    async dispatchReady(id, request) {
        const row = this.get(id);
        if (!['ready', 'waiting_approval'].includes(row.state)) return { id, state: row.state, receipt: row.receipt ? JSON.parse(row.receipt) : undefined };
        try { authorizeDelivery(request, this.policy(), { store: this.store }); } catch (error) { this.set(id, 'revoked', { error: error.message }); return { id, state: 'revoked' }; }
        if (request.expiresAt <= Date.now()) { this.set(id, 'expired'); return { id, state: 'expired' }; }
        if (request.progressToken && !currentProgressToken(request.progressToken)) { this.set(id,'suppressed'); return {id,state:'suppressed'}; }
        // The durable native intent is the sole owner from this point onward.
        const claimed = this.store.db.prepare("UPDATE deliveries SET state='dispatching',updated=? WHERE id=? AND state IN ('ready','waiting_approval')").run(Date.now(), id).changes;
        if (!claimed) return { id, state: this.get(id).state };
        try {
            const payloads = request.parts.map((part, index) => ({
                ...(part.type === 'text' ? { text: part.text } : part.type === 'forward' ? {text:request.feature==='x'?'X媒体合并消息':'小红书媒体合并消息'} : { mediaUrl: part.path, ...(part.caption ? { text: part.caption } : {}) }),
                channelData: { onebotDelivery: { id, index, kind: part.type } },
            }));
            const result = await this.send({ cfg: await this.config(), channel: 'onebot', accountId: request.accountId,
                to: `${request.target.type}:${request.target.id}`, payloads, durability: 'required', deliveryIntentId: id,
                reusePendingDeliveryIntent: true, completionRetention: 'permanent',
                session: request.sessionKey ? { key: request.sessionKey, agentId: request.workspaceAgentId } : undefined,
                onDeliveryIntent: intent => this.store.db.prepare('UPDATE deliveries SET native_id=?,updated=? WHERE id=?').run(String(intent.queueId ?? intent.id ?? id), Date.now(), id) });
            if (this.get(id).state === 'accepted') return { id, state: 'accepted', receipt: JSON.parse(this.get(id).receipt) };
            const state = result.status === 'sent' ? 'accepted' : result.status === 'suppressed' ? 'suppressed' : 'native_pending';
            this.set(id, state, result.receipt ?? { status: result.status, error: String(result.error?.message ?? result.error ?? '').slice(0, 1000) });
            return { id, state, receipt: result.receipt };
        } catch (error) {
            if (this.get(id).state === 'accepted') return { id, state: 'accepted', receipt: JSON.parse(this.get(id).receipt) };
            // Never retry here: native queue may already have dispatched a part.
            this.set(id, 'uncertain', { error: String(error.message).slice(0, 1000) });
            return { id, state: 'uncertain' };
        }
    }
    set(id, state, receipt = null) {
        if(state==='accepted' && receipt) {
            const request=JSON.parse(this.get(id).request);
            if(request.context?.mediaCompletionFast && request.parts?.some(p=>p.type==='forward') && ['x','xiaohongshu'].includes(request.feature)) closeProgressForContext(request.context);
        }
        this.store.db.prepare('UPDATE deliveries SET state=?,receipt=?,updated=? WHERE id=?').run(state, receipt ? canonical(receipt) : null, Date.now(), id);
    }
    async resolveApproval(approvalId, allowed) {
        const rows = this.store.db.prepare('SELECT delivery_id FROM dependencies WHERE approval_id=? AND resolved=0').all(approvalId);
        for (const row of rows) {
            if (!allowed) this.set(row.delivery_id, 'denied');
            else { this.store.db.prepare('UPDATE dependencies SET resolved=1 WHERE delivery_id=? AND approval_id=?').run(row.delivery_id, approvalId); await this.dispatch(row.delivery_id); }
        }
    }
    async recover() {
        // A crash during dispatch cannot justify a second native intent.
        this.store.db.prepare("UPDATE deliveries SET state='uncertain',updated=? WHERE state='dispatching'").run(Date.now());
        for (const row of this.store.db.prepare("SELECT id FROM deliveries WHERE state IN ('ready','waiting_approval') ORDER BY created").all()) {
            try { await this.dispatch(row.id); }
            catch { this.set(row.id, 'failed_corrupt', { reason: 'invalid persisted delivery; no platform send attempted' }); }
        }
    }
}
let queue;
export function deliveryQueue() { return queue ??= new DeliveryQueue(); }
export function validateNativeDelivery(id, index, accountId, to) {
    const row = deliveryQueue().get(id);
    if (!row || !['dispatching', 'native_pending', 'uncertain', 'accepted'].includes(row.state)) throw new Error('invalid durable producer');
    const request = JSON.parse(row.request);
    authorizeDelivery(request);
    if (request.progressToken && !currentProgressToken(request.progressToken)) throw new Error('stale task progress');
    if (request.expiresAt <= Date.now()) throw new Error('delivery expired');
    if (request.accountId !== accountId || `${request.target.type}:${request.target.id}` !== to.replace(/^onebot:/u, '')) throw new Error('durable destination mismatch');
    if (!Number.isInteger(index) || !request.parts[index]) throw new Error('invalid delivery part');
    return request.parts[index];
}
// Only channel transport uses this metadata after validating the durable grant.
export function nativeDeliveryContext(id, index, accountId, to) {
    validateNativeDelivery(id, index, accountId, to);
    const request = JSON.parse(deliveryQueue().get(id).request);
    return { workspaceAgentId: request.workspaceAgentId, sessionKey: request.sessionKey };
}
export function acceptedPart(id, index) {
    return operationStore().db.prepare('SELECT message_id FROM delivery_parts WHERE delivery_id=? AND part_index=?').get(id, index)?.message_id;
}
export function recordAcceptedPart(id, index, messageId) {
    const queue = deliveryQueue(), store = operationStore();
    store.transaction(() => {
        store.db.prepare('INSERT OR IGNORE INTO delivery_parts VALUES(?,?,?,?)').run(id, index, String(messageId), Date.now());
        const request = JSON.parse(queue.get(id).request);
        const parts = store.db.prepare('SELECT * FROM delivery_parts WHERE delivery_id=? ORDER BY part_index').all(id);
        if (parts.length === request.parts.length) queue.set(id, 'accepted', { primaryPlatformMessageId: parts[0].message_id,
            platformMessageIds: parts.map(part => part.message_id), parts: parts.map(part => ({ index: part.part_index, platformMessageId: part.message_id,
                kind: request.parts[part.part_index].type === 'text' ? 'text' : 'media' })) });
    });
}
export function registerDeliveryRecovery(api) {
    api.registerService({ id: 'onebot-business-outbox', start: async () => {
        const store = operationStore();
        for (const op of store.db.prepare("SELECT id FROM operations WHERE state='running'").all()) store.state(op.id, 'uncertain', { reason: 'gateway restarted during execution; reconcile before repeating' });
        for (const op of store.db.prepare("SELECT id FROM operations WHERE state='waiting_approval' AND created<?").all(Date.now() - 600000)) store.state(op.id, 'expired');
        await deliveryQueue().recover();
    }, stop: async () => {} });
}

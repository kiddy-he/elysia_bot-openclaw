import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { onebotPath } from '../paths.js';
import { loadFeatureConfig, outboundTargetAllowed } from '../feature-policy.js';
import { validateBilibiliConfig } from './bilibili.js';

const events = ['dynamic', 'live'];
const features = [...events, 'liveEnd', 'liveGuardBuy', 'superchat', 'specialDanmaku', 'specialUserEnter'];
const uuid = seed => {
    const h = createHash('sha256').update(seed).digest('hex').slice(0, 32).split('');
    h[12] = '4'; h[16] = '8'; const s = h.join('');
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
};
const atomic = async (path, value) => {
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await rename(temp, path);
};

/** Fixed loopback destination and credentials never originate in model input. */
export async function createBilibiliClient({ root = onebotPath(), request = fetch } = {}) {
    let env;
    try {
        env = Object.fromEntries((await readFile(join(root, 'onebot-onebot-custom/integrations/bilibili-notify/.env'), 'utf8'))
            .split(/\r?\n/u).filter(line => line && !line.startsWith('#')).map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
    } catch { throw new Error('B站监控服务凭据不可用；未读取或修改登录信息。'); }
    if (!env.BN_DASHBOARD_USER || !env.BN_DASHBOARD_PASS) throw new Error('B站监控服务凭据未配置。');
    let cookie;
    const call = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
        if (!/^\/api\/[A-Za-z0-9/?=&_-]+$/u.test(path)) throw new Error('invalid fixed Bilibili API path');
        let response;
        try {
            response = await request(`http://127.0.0.1:8787${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(12000),
                headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:8787', ...(cookie ? { Cookie: cookie } : {}) },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
            if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
            if (path === '/api/session/login') cookie = response.headers.get('set-cookie')?.split(';')[0];
            const text = await response.text();
            if (text.length > 2 * 1024 * 1024) throw new Error('response too large');
            return text ? JSON.parse(text) : null;
        } catch {
            // Never surface upstream bodies, headers, cookies or fetch diagnostics.
            throw new Error('B站监控服务请求失败，订阅同步结果需核对；未自动重发请求。');
        }
    };
    await call('/api/session/login', { username: env.BN_DASHBOARD_USER, password: env.BN_DASHBOARD_PASS });
    if (!cookie) throw new Error('B站监控面板登录失败。');
    return { call };
}

function destination(params, policy) {
    const groupId = String(params.groupId ?? params.originGroupId ?? '');
    if (!['default', 'yuexia'].includes(params.accountId) || !/^[1-9][0-9]{4,19}$/u.test(groupId)
        || (params.originGroupId && String(params.originGroupId) !== groupId)
        || !policy.features.bilibili.enabled || !policy.features.bilibili.accountIds.includes(params.accountId)
        || !policy.features.bilibili.groupIds.includes(groupId) || !outboundTargetAllowed(policy, params.accountId, 'group', groupId))
        throw new Error('只允许管理当前账号已授权群聊的B站订阅。');
    return groupId;
}
const scoped = (route, accountId, groupId) => route.accountId === accountId && route.groupId === groupId;
const cleanSub = sub => Object.fromEntries(['id', 'uid', 'name', 'enabled', 'groups', 'notes', 'routing', 'extras', 'overrides', 'roastSchedule', 'specialUsers']
    .filter(key => sub[key] !== undefined).map(key => [key, structuredClone(sub[key])]));

/** Serialize across executor child processes; never steal a possibly-live lock. */
export async function syncBilibiliSubscription(params, { root = onebotPath(), policy = loadFeatureConfig(), client, clientFactory = createBilibiliClient } = {}) {
    const groupId = destination(params, policy), accountId = params.accountId;
    if (!['add', 'remove'].includes(params.action) || !['dynamic', 'live', 'all'].includes(params.event ?? 'all')) throw new Error('无效订阅操作或事件类型。');
    if (params.uid && !/^[1-9][0-9]{0,19}$/u.test(params.uid)) throw new Error('无效UP主UID。');
    if (params.targetId && !/^[A-Za-z0-9_-]{1,100}$/u.test(params.targetId)) throw new Error('无效订阅标识。');
    if (!params.uid && !params.targetId) throw new Error('请提供UP主UID。');
    const state = join(root, 'state/business/bilibili-sync'); await mkdir(state, { recursive: true, mode: 0o700 });
    const lock = join(state, 'lock');
    try { await mkdir(lock, { mode: 0o700 }); } catch (error) {
        if (error.code === 'EEXIST') throw new Error('另一项B站订阅同步正在处理或需恢复，请先核对原操作。'); throw error;
    }
    let config, selected = [], changed = false;
    const path = join(root, 'onebot-bilibili.json');
    const journalPath = join(state, `${createHash('sha256').update(`${accountId}:${groupId}:${params.uid ?? params.targetId}`).digest('hex')}.json`);
    let uid, requested;
    try {
        config = validateBilibiliConfig(JSON.parse(await readFile(path, 'utf8')));
        if (!config.enabled) throw new Error('B站事件接入未启用。');
        const existing = params.targetId ? config.routes.find(r => r.targetId === params.targetId) : null;
        if (existing && !scoped(existing, accountId, groupId)) throw new Error('不能修改其他群聊或其他账号的订阅。');
        if (existing && params.uid && params.uid !== existing.uid) throw new Error('UP主UID与订阅标识不一致。');
        uid = params.uid ?? existing?.uid;
        if (!uid) throw new Error('未找到本群订阅，请提供UP主UID。');
        requested = params.event ? (params.event === 'all' ? events : [params.event])
            : existing ? (existing.event === 'all' ? events : [existing.event]) : events;
        // A target alias is only a legacy lookup, never an external destination.
        selected = config.routes.filter(r => scoped(r, accountId, groupId) && r.uid === uid
            && (r.event === 'all' || requested.includes(r.event)));
        if (params.action === 'remove') {
            // Revoke delivery first, including already-queued notifications.
            for (const route of selected) {
                route.enabled = false;
            }
            await atomic(path, validateBilibiliConfig(config)); changed = true;
        }
        await atomic(journalPath, { version: 1, action: params.action, accountId, groupId, uid, events: requested, state: 'syncing', updatedAt: new Date().toISOString() });
        client ??= await clientFactory({ root });
        const call = client.call;
        const login = await call('/api/auth/status');
        if (params.action === 'add' && login.status !== 5) throw new Error('B站账号未登录，添加订阅未完成；请先完成扫码登录。');
        let subs = await call('/api/subs');
        const matches = subs.filter(s => s.uid === uid);
        if (matches.length > 1) throw new Error('该UID存在重复上游订阅，请先核对后再修改。');
        let sub = matches[0];
        if (params.action === 'add') {
            let targets = await call('/api/targets');
            const connections = await call('/api/connections');
            let secret;
            try { secret = (await readFile(config.secretFile, 'utf8')).trim(); }
            catch { throw new Error('B站事件校验配置不可用。'); }
            if (secret.length < 32) throw new Error('B站事件校验配置不可用。');
            for (const event of requested) {
                let route = selected.find(r => r.event === event || r.event === 'all');
                if (!route) {
                    const connectionId = uuid(`openclaw:bilibili:${accountId}:${groupId}:${uid}:${event}`);
                    const connection = connections.find(c => c.id === connectionId);
                    if (connection && (connection.kind !== 'direct' || connection.platform !== 'generic'
                        || connection.config?.url !== 'http://127.0.0.1:18789/onebot/bilibili/events')) throw new Error('上游目标标识冲突，请先核对。');
                    await call('/api/connections', { id: connectionId, name: `QQ${groupId}-UP${uid}-${event}`, enabled: true,
                        kind: 'direct', connector: 'webhook', platform: 'generic',
                        config: { url: 'http://127.0.0.1:18789/onebot/bilibili/events', secret, headers: {} } });
                    targets = await call('/api/targets');
                    const target = targets.find(t => t.connectionId === connectionId && t.kind === 'endpoint' && t.enabled);
                    if (!target) throw new Error('上游未创建有效推送目标。');
                    if (config.routes.some(r => r.targetId === target.id)) throw new Error('推送目标已绑定其他路由。');
                    route = { targetId: target.id, uid, event, accountId, groupId, enabled: false };
                    config.routes.push(route); selected.push(route);
                }
                const target = targets.find(t => t.id === route.targetId && t.enabled && t.kind === 'endpoint');
                const connection = target && (await call('/api/connections')).find(c => c.id === target.connectionId);
                if (!target || !connection?.enabled || connection.platform !== 'generic'
                    || connection.config?.url !== 'http://127.0.0.1:18789/onebot/bilibili/events') throw new Error('已有路由的上游目标不可用；未伪称订阅成功。');
            }
            await atomic(path, validateBilibiliConfig(config)); changed = true;
            if (!sub) {
                const profile = await call(`/api/subs/lookup?uid=${uid}`);
                sub = { id: uuid(`openclaw:bilibili:subscription:${uid}`), uid, name: String(profile.name ?? uid).slice(0, 100), enabled: false,
                    groups: [], routing: Object.fromEntries(features.map(f => [f, []])), specialUsers: [],
                    overrides: { features: { dynamic: true, live: true, liveEnd: false, liveGuardBuy: false, superchat: false,
                        specialDanmaku: false, specialUserEnter: false, extras: { atAllDynamic: false, atAllLive: false, wordcloud: false, liveSummary: false } },
                    schedule: { restartPush: false }, imageGroup: { enable: false, forward: false } } };
                await call('/api/subs', sub);
                sub = (await call('/api/subs')).find(s => s.id === sub.id);
            }
            // POST performs ensureFollowed; PATCH alone does not. Reuse the same
            // subscription ID and retain every other group's targets/settings.
            if (requested.includes('dynamic') && sub.followed !== true) {
                await call('/api/subs', cleanSub(sub));
                sub = (await call('/api/subs')).find(s => s.id === sub.id);
                if (sub?.followed !== true) throw new Error('UP主关注未确认成功，动态订阅尚未完成。');
            }
            const routing = structuredClone(sub.routing), extras = structuredClone(sub.extras ?? {});
            for (const event of requested) {
                const ids = selected.filter(r => r.event === event || r.event === 'all').map(r => r.targetId);
                routing[event] = [...new Set([...(routing[event] ?? []), ...ids])];
                const key = event === 'dynamic' ? 'atAllDynamic' : 'atAllLive'; extras[key] ??= {};
                for (const id of ids) extras[key][id] = false;
            }
            await call(`/api/subs/${sub.id}`, { enabled: true, routing, extras,
                overrides: { features: Object.fromEntries(requested.map(e => [e, true])) } }, 'PATCH');
            sub = (await call('/api/subs')).find(s => s.id === sub.id);
            if (!sub?.enabled || requested.some(e => sub.overrides?.features?.[e] === false
                || selected.filter(r => r.event === e || r.event === 'all').some(r => !sub.routing[e]?.includes(r.targetId))))
                throw new Error('上游订阅回读校验失败。');
            for (const route of selected) route.enabled = true;
            await atomic(path, validateBilibiliConfig(config));
        } else {
            if (sub) {
                const routing = structuredClone(sub.routing), extras = structuredClone(sub.extras ?? {});
                for (const event of requested) {
                    const ids = new Set(selected.map(r => r.targetId));
                    routing[event] = (routing[event] ?? []).filter(id => !ids.has(id));
                    for (const key of event === 'dynamic' ? ['atAllDynamic'] : ['atAllLive']) for (const id of ids) if (extras[key]) delete extras[key][id];
                }
                const enabled = Object.values(routing).some(ids => ids.length) ? sub.enabled : false;
                await call(`/api/subs/${sub.id}`, { routing, extras, enabled }, 'PATCH');
                sub = (await call('/api/subs')).find(s => s.id === sub.id);
                if (sub && requested.some(e => selected.some(r => sub.routing[e]?.includes(r.targetId)))) throw new Error('上游取消订阅回读校验失败。');
            }
            // A legacy shared endpoint remains muted until its selected event
            // is removed upstream; preserve the other event only after readback.
            for (const route of selected) if (route.event === 'all' && requested.length === 1) {
                route.event = requested[0] === 'live' ? 'dynamic' : 'live'; route.enabled = true;
            }
            const removed = new Set(selected.filter(r => !r.enabled).map(r => r.targetId));
            config.routes = config.routes.filter(r => !removed.has(r.targetId));
            await atomic(path, validateBilibiliConfig(config));
            // Keep dormant endpoint identities for idempotent re-add. Never
            // unfollow the UP or delete a subscription used by another group.
        }
        const result = { ok: true, status: params.action === 'add' ? 'subscribed' : 'unsubscribed', groupId, accountId, uid,
            events: requested, upstreamSynchronized: true, monitoringConfigured: params.action === 'add',
            ...(params.action === 'add' ? { followed: sub.followed === true } : {}), deliveryVerified: false };
        await atomic(journalPath, { ...result, state: 'synchronized', updatedAt: new Date().toISOString() });
        return result;
    } catch (error) {
        await atomic(journalPath, { state: 'needs_reconciliation', action: params.action, accountId, groupId, uid,
            deliveryRevoked: params.action === 'remove' && changed, updatedAt: new Date().toISOString() }).catch(() => {});
        // A local tombstone keeps notifications revoked if upstream is down.
        throw new Error(params.action === 'remove' && changed
            ? '本群选定通知已停用，但上游取消同步尚未完成；请核对或重试相同取消请求，其他群订阅未主动修改。'
            : error.code ? 'B站订阅同步遇到本地存储错误，需核对原操作后重试；未确认成功。' : error.message);
    } finally { await rm(lock, { recursive: true, force: true }); }
}

export async function bilibiliSubscriptionStatus(params, { root = onebotPath(), policy = loadFeatureConfig(), client, clientFactory = createBilibiliClient } = {}) {
    const groupId = destination(params, policy);
    const config = validateBilibiliConfig(JSON.parse(await readFile(join(root, 'onebot-bilibili.json'), 'utf8')));
    const routes = config.routes.filter(r => scoped(r, params.accountId, groupId));
    client ??= await clientFactory({ root });
    const [auth, subs, targets, connections] = await Promise.all([client.call('/api/auth/status'), client.call('/api/subs'), client.call('/api/targets'), client.call('/api/connections')]);
    return { ok: true, groupId, accountId: params.accountId, ingressEnabled: config.enabled, loggedIn: auth.status === 5,
        subscriptions: routes.map(r => ({ uid: r.uid, event: r.event, enabled: r.enabled,
            synchronized: r.enabled && config.enabled && targets.some(t => t.id === r.targetId && t.enabled
                && connections.some(c => c.id === t.connectionId && c.enabled && c.platform === 'generic'
                    && c.config?.url === 'http://127.0.0.1:18789/onebot/bilibili/events'))
                && subs.some(s => s.uid === r.uid && s.enabled && (r.event === 'all' ? events : [r.event]).every(e => s.routing[e]?.includes(r.targetId))
                    && (r.event === 'live' || s.followed === true)) })), deliveryVerified: false };
}

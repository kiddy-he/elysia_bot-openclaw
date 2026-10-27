import { onebotPath } from '../paths.js';
import { timingSafeEqual } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { digest, operationStore } from '../access/operations.js';
import { deliveryQueue, authorizeDelivery } from '../delivery/queue.js';
import { loadFeatureConfig } from '../feature-policy.js';
import { generateLiveNotice, normalizeLiveNotice } from './bilibili-live-notice.js';

const inFlight = new WeakMap();

export function validateBilibiliConfig(config) {
    if (config.version !== 1 || typeof config.enabled !== 'boolean' || !Array.isArray(config.routes) || config.routes.length > 100) throw new Error('invalid Bilibili configuration');
    if (config.liveNotifications !== undefined && (typeof config.liveNotifications?.enabled !== 'boolean'
        || Object.keys(config.liveNotifications).some(key => key !== 'enabled'))) throw new Error('invalid live notifications configuration');
    const aliases = new Set();
    for (const route of config.routes) {
        if (!/^[a-zA-Z0-9_-]{1,100}$/u.test(route.targetId) || aliases.has(route.targetId) || !/^[1-9][0-9]{0,19}$/u.test(route.uid)
            || !['dynamic', 'live', 'all'].includes(route.event) || !['default', 'yuexia'].includes(route.accountId)
            || !/^[1-9][0-9]{4,19}$/u.test(route.groupId) || typeof route.enabled !== 'boolean') throw new Error('invalid Bilibili route');
        aliases.add(route.targetId);
    }
    return config;
}
async function loadConfig() { return validateBilibiliConfig(JSON.parse(await readFile(onebotPath('onebot-bilibili.json'), 'utf8'))); }
function checkSecret(value, expected) {
    if (typeof value !== 'string' || !expected || expected.length < 32) return false;
    const a = Buffer.from(value), b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}
function payloadParts(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('missing payload');
    if (payload.kind === 'text') return [{ type: 'text', text: String(payload.text ?? '').slice(0, 16000) }];
    if (['link', 'miniapp-card'].includes(payload.kind)) {
        const url = new URL(payload.jumpUrl);
        if (url.protocol !== 'https:' || !/(?:^|\.)(?:bilibili\.com|b23\.tv)$/u.test(url.hostname)) throw new Error('invalid Bilibili link');
        return [{ type: 'text', text: `${String(payload.title ?? '').slice(0, 1000)}\n${url.href}` }];
    }
    if (payload.kind === 'image') return [{ type: 'inline-image', image: payload.image }, ...(payload.caption ? [{ type: 'text', text: String(payload.caption).slice(0, 16000) }] : [])];
    if (['segments', 'composite'].includes(payload.kind) && Array.isArray(payload.segments) && payload.segments.length <= 20) return payload.segments.flatMap(segment => segment.type === 'text'
        ? [{ type: 'text', text: String(segment.text ?? '').slice(0, 16000) }] : segment.type === 'image' ? [{ type: 'inline-image', image: segment.image ?? { mime: segment.mime, data: segment.data } }] : []);
    if (payload.kind === 'forward-images' && Array.isArray(payload.images) && payload.images.length <= 20) return payload.images.map(image => {
        const url = new URL(image.url);
        if (url.protocol !== 'https:' || url.username || url.password || !/(?:^|\.)(?:bilibili\.com|hdslb\.com|b23\.tv)$/u.test(url.hostname) || url.href.length > 2048) throw new Error('invalid forwarded image URL');
        return { type: 'text', text: url.href };
    });
    throw new Error('unsupported webhook payload');
}
export async function acceptBilibiliEvent(body, secret, { config, expectedSecret, queue = deliveryQueue(), store = operationStore(), policy = loadFeatureConfig(), now = Date.now(), artifactRoot = onebotPath('state/business/bilibili-incoming'), composeLive = generateLiveNotice } = {}) {
    validateBilibiliConfig(config);
    if (!checkSecret(secret, expectedSecret)) throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
    if (!config.enabled) throw Object.assign(new Error('Bilibili ingress disabled'), { statusCode: 503 });
    const timestamp = typeof body.ts === 'string' ? Date.parse(body.ts) : body.ts;
    if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > 300000) throw new Error('stale webhook');
    const route = config.routes.find(route => route.enabled && route.targetId === body.targetId);
    if (!route) throw new Error('unconfigured upstream target alias');
    const live = body.live ? normalizeLiveNotice(body.live, route.uid) : null;
    if (live && !['live', 'all'].includes(route.event)) throw new Error('live metadata on non-live route');
    const compose = live && config.liveNotifications?.enabled;
    const request = { accountId: route.accountId, target: { type: 'group', id: route.groupId }, feature: 'bilibili', action: 'read',
        // The authenticated route fixes the destination. body.scope/private/targetName cannot change it.
        parts: [], dedupeKey: `bilibili:${route.targetId}:${route.uid}:${route.event}:${digest(body.payload)}`, bilibiliRoute: route.targetId };
    authorizeDelivery(request, policy, { bilibiliConfig: config });
    const eventInput = { uid: route.uid, targetAlias: route.targetId,
        payloadHash: live?.startedAt ? digest({ roomId: live.roomId, startedAt: live.startedAt }) : digest(body.payload) };
    const rawPayload = JSON.stringify(body.payload);
    const sourceId = live?.startedAt ? `live-${digest({ uid: live.uid, roomId: live.roomId, startedAt: live.startedAt })}`
        : /^[a-zA-Z0-9:_-]{1,150}$/u.test(body.eventId ?? '') ? body.eventId : /https:\/\/(?:t\.bilibili\.com\/|www\.bilibili\.com\/opus\/)([0-9]+)/u.exec(rawPayload)?.[1];
    if (sourceId) request.dedupeKey = `bilibili:${route.targetId}:${route.uid}:${route.event}:${sourceId}`;
    else {
        // Generic upstream has no event id. Suppress identical payloads within a bounded
        // window rather than suppressing an UP's future streams with the same title forever.
        const recent = store.db.prepare("SELECT * FROM operations WHERE kind='bilibili-event' AND fingerprint=? AND created>? ORDER BY created DESC LIMIT 1")
            .get(digest({ kind: 'bilibili-event', input: eventInput }), now - (route.event === 'live' ? 3600000 : 86400000));
        request.dedupeKey = recent?.id ?? `${request.dedupeKey}:${timestamp}`;
    }
    const existingEvent = store.get(request.dedupeKey);
    if (existingEvent?.result) return JSON.parse(existingEvent.result);
    const operation = store.begin('bilibili-event', eventInput, request.dedupeKey);
    request.operationId = operation.id;
    if (operation.result) return JSON.parse(operation.result);
    let flights = inFlight.get(store);
    if (!flights) { flights = new Map(); inFlight.set(store, flights); }
    if (flights.has(operation.id)) return flights.get(operation.id);
    const work = (async () => {
        // Save the final public copy before handing ownership to the durable outbox.
        // A queue failure/retry must reuse exactly the same caption and image.
        store.db.exec('CREATE TABLE IF NOT EXISTS bilibili_live_prepared(id TEXT PRIMARY KEY, request TEXT NOT NULL, created INTEGER NOT NULL)');
        const cached = store.db.prepare('SELECT request FROM bilibili_live_prepared WHERE id=?').get(operation.id);
        if (cached) {
            const saved = JSON.parse(cached.request);
            request.parts = saved.parts;
        } else {
            const parts = payloadParts(body.payload);
            for (const part of parts) {
                if (part.type === 'text') {
                    const text = part.text.replace(/\[CQ:[^\]]*\]/gu, '').trim();
                    for (let offset = 0; offset < text.length; offset += 4500) request.parts.push({ type: 'text', text: text.slice(offset, offset + 4500) });
                } else {
                    const image = part.image;
                    if (!image || !['image/png', 'image/jpeg', 'image/webp'].includes(image.mime) || typeof image.data !== 'string' || image.data.length > 16 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(image.data)) throw new Error('invalid inline image');
                    const bytes = Buffer.from(image.data, 'base64');
                    if (bytes.length > 12 * 1024 * 1024 || !(bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) || (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'))) throw new Error('invalid image signature');
                    await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
                    const path = `${artifactRoot}/${digest(image.data)}.${image.mime === 'image/png' ? 'png' : image.mime === 'image/jpeg' ? 'jpg' : 'webp'}`;
                    await writeFile(path, bytes, { mode: 0o600 }); request.parts.push({ type: 'image', path });
                }
            }
            if (!request.parts.length) throw new Error('empty webhook');
            if (compose) {
                const images = request.parts.filter(part => part.type === 'image');
                if (images.length > 1) throw new Error('live start requires a single template image');
                const copy = await composeLive(live);
                if (typeof copy?.text !== 'string' || !copy.text.trim() || copy.text.length > 4500) throw new Error('invalid live copy result');
                // One image part with its caption is a single OneBot message, one native
                // intent and one receipt. No image can leave before copy completion.
                request.parts = images.length ? [{ ...images[0], caption: copy.text }] : [{ type: 'text', text: copy.text }];
                store.db.prepare('INSERT INTO bilibili_live_prepared VALUES(?,?,?)').run(operation.id, JSON.stringify({ parts: request.parts }), Date.now());
            }
        }
        const result = await queue.enqueue(request);
        const value = { operationId: operation.id, deliveryId: result.id, state: result.state };
        store.state(operation.id, result.state === 'accepted' ? 'succeeded' : result.state, value);
        return value;
    })();
    flights.set(operation.id, work);
    try { return await work; } finally { flights.delete(operation.id); }
}
export function registerBilibiliWebhook(api) {
    api.registerHttpRoute({ path: '/onebot/bilibili/events', auth: 'plugin', handler: async (req, res) => {
        try {
            if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
            const config = await loadConfig();
            if (!config.enabled) { res.writeHead(503); res.end('{"error":"Bilibili ingress disabled"}'); return; }
            const expectedSecret = (await readFile(config.secretFile, 'utf8')).trim();
            if (!checkSecret(req.headers['x-bilibili-notify-secret'], expectedSecret)) { res.writeHead(401); res.end(); return; }
            const chunks = []; let bytes = 0;
            for await (const chunk of req) {
                bytes += chunk.length;
                if (bytes > 18 * 1024 * 1024) throw Object.assign(new Error('payload too large'), { statusCode: 413 });
                chunks.push(chunk);
            }
            const result = await acceptBilibiliEvent(JSON.parse(Buffer.concat(chunks).toString('utf8')), req.headers['x-bilibili-notify-secret'], { config, expectedSecret });
            res.writeHead(202, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
        } catch (error) { res.writeHead(error.statusCode ?? 400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: String(error.message).slice(0, 200) })); }
    } });
}

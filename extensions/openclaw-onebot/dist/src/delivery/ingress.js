import { onebotPath } from '../paths.js';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { deliveryQueue } from './queue.js';
import { loadFeatureConfig } from '../feature-policy.js';

export function registerScriptDelivery(api) {
    api.registerHttpRoute({ path: '/onebot/internal/deliver', auth: 'plugin', handler: async (req, res) => {
        try {
            if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) || req.method !== 'POST') { res.writeHead(403); res.end(); return; }
            const expected = (await readFile(onebotPath('secrets/onebot-delivery.key'), 'utf8')).trim();
            const actual = String(req.headers.authorization ?? '').replace(/^Bearer /u, '');
            if (actual.length !== expected.length || !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) { res.writeHead(401); res.end(); return; }
            let bytes = 0; const chunks = [];
            for await (const chunk of req) { bytes += chunk.length; if (bytes > 100000) throw new Error('request too large'); chunks.push(chunk); }
            const input = JSON.parse(Buffer.concat(chunks));
            if (!['alas-monitor', 'alas-screenshot', 'qzone-daily'].includes(input.service)) throw new Error('unregistered delivery service');
            const policy = loadFeatureConfig();
            const targetId = String(input.targetId);
            if (!policy.accounts.default.privateAdminIds.includes(targetId)) throw new Error('service target is not registered owner');
            if (input.service === 'qzone-daily') {
                if (input.originJobId !== '4b13a241-07de-57bb-8d55-7c7fb958b5f3'
                    || typeof input.dedupeKey !== 'string' || !/^qzone-daily:\d{4}-\d{2}-\d{2}:(?:prepare|publish):/u.test(input.dedupeKey)
                    || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 2000) throw new Error('invalid Qzone daily notification');
                const result = await deliveryQueue().enqueue({ feature: 'qzone', action: 'publish', accountId: 'default',
                    scriptService: input.service, originJobId: input.originJobId,
                    target: { type: 'private', id: targetId }, parts: [{ type: 'text', text: input.text }], dedupeKey: input.dedupeKey });
                res.writeHead(result.state === 'accepted' ? 200 : 202, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
                return;
            }
            const type = input.service === 'alas-screenshot' ? 'image' : 'text';
            if (type === 'text' && (typeof input.text !== 'string' || input.text.length > 40000)) throw new Error('invalid text');
            if (type === 'image') {
                const path = String(input.path);
                const image = await readFile(path);
                if (!image.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || image.length > 25 * 1024 * 1024) throw new Error('invalid screenshot');
            }
            const parts = type === 'image' ? [{ type, path: input.path }] : [];
            if (type === 'text') for (let i = 0; i < input.text.length; i += 4500) parts.push({ type, text: input.text.slice(i, i + 4500) });
            const result = await deliveryQueue().enqueue({ feature: 'alas', action: type === 'image' ? 'screenshot' : 'control', accountId: 'default',
                scriptService: input.service,
                originJobId: input.service === 'alas-monitor' ? '6d3bc95e-82c6-5cae-b601-93abd91418a6' : undefined,
                target: { type: 'private', id: targetId }, parts, dedupeKey: input.dedupeKey });
            res.writeHead(result.state === 'accepted' ? 200 : 202, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
        } catch (error) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: String(error.message).slice(0, 300) })); }
    } });
}

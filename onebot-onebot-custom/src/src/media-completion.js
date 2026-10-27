import { selectedMediaPosts, MEDIA_REPLY_BUDGET } from './media-reply.js';
import { createHash } from 'node:crypto';

const bindings = new Map();
function key(context) {
    if (!context?.requestId || !context.sessionKey || !context.senderId || !context.accountId) return null;
    return JSON.stringify([context.sessionKey, context.accountId, context.scope, String(context.groupId ?? ''), String(context.senderId), String(context.requestId)]);
}
export function bindMediaCompletion(context, coordinator) {
    const id = key(context);
    if (!id) throw new Error('media completion needs a bound inbound turn');
    const entries = bindings.get(id) ?? new Set(); entries.add(coordinator); bindings.set(id, entries);
    return () => { entries.delete(coordinator); if (!entries.size) bindings.delete(id); coordinator.cancel(); };
}
function bound(context) { const entries = bindings.get(key(context)); return entries?.size === 1 ? [...entries][0] : null; }
export function notifyMediaSelected(context, feature, posts) { bound(context)?.selected(feature, posts); }
export async function notifyMediaResult(context, feature, result) { return await bound(context)?.complete(feature, result); }

export function mediaCompletionEligible(intent, { speechExplicit = false, peerFollowup = false, hasInboundMedia = false } = {}) {
    return intent?.mediaReplyMode === 'complete' && Boolean(intent.xOperation) !== Boolean(intent.xiaohongshuOperation)
        && !speechExplicit && !peerFollowup && !hasInboundMedia;
}
export function mediaCompletionId(context) { return `media-final-${createHash('sha256').update(key(context) ?? '').digest('hex')}`; }
function verified(result) {
    const data = result?.data;
    return result?.ok === true && data?.delivery_status === 'delivered' && data.receipt && data.delivery_id
        && Number.isSafeInteger(data.media_count) && data.media_count > 0 && Array.isArray(data.posts) && data.posts.length > 0;
}
function fallbackText(feature, data, personaName) {
    const label = feature === 'x' ? 'X' : '小红书';
    const facts = `${label} 的 ${data.posts.length} 个帖子、共 ${data.media_count} 个图片或视频，已放在一条合并消息中发送。`;
    return personaName === '月下初拥' ? `${facts}可以慢慢看。` : `${facts}慢慢看吧♪`;
}

// Preparation never blocks media. The post-receipt budget applies only to the
// remaining preparation time; every late candidate is discarded on fallback.
export function createMediaCompletion({ feature, personaName = '爱莉希雅', prepare, send, onReceipt = () => {},
    isCurrent = () => true, signal, maxWaitMs = MEDIA_REPLY_BUDGET.afterReceiptMs, log = () => {} }) {
    const controller = new AbortController();
    const prepSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let selected = false, claimed = false, cancelled = false, preparation = Promise.resolve(null), resolveDone;
    const done = new Promise(resolve => { resolveDone = resolve; });
    // Let the executor return its durable result and the host append toolResult
    // before the gateway cancels the redundant next model step.
    const settle = value => setImmediate(() => resolveDone(value));
    return {
        done,
        selected(platform, posts) {
            if (cancelled || claimed || selected || platform !== feature || !isCurrent()) return;
            selected = true;
            const publicPosts = selectedMediaPosts(posts);
            const started = Date.now();
            preparation = Promise.resolve().then(() => prepare({ feature, posts: publicPosts, signal: prepSignal })).catch(() => null)
                .then(candidate => { if(!cancelled) log({event:'prepared',elapsedMs:Date.now()-started,prepared:Boolean(candidate?.text)}); return candidate; });
        },
        async complete(platform, result) {
            if (cancelled || claimed || platform !== feature || !verified(result) || !isCurrent() || signal?.aborted) return false;
            claimed = true;
            const started = Date.now();
            let timer, onAbort;
            try {
                onReceipt(result);
                const candidate = await Promise.race([preparation, new Promise(resolve => {
                    timer = setTimeout(() => resolve(null), maxWaitMs);
                    onAbort = () => resolve(null); prepSignal.addEventListener('abort', onAbort, { once: true });
                    if (prepSignal.aborted) resolve(null);
                })]);
                if (cancelled || signal?.aborted || !isCurrent()) return false;
                const text = candidate?.text?.trim()
                    ? `${candidate.text.trim()}\n${feature === 'x' ? 'X' : '小红书'}：${result.data.posts.length} 个帖子，共 ${result.data.media_count} 个图片或视频，已通过一条合并消息发送。`
                    : fallbackText(feature, result.data, personaName);
                controller.abort();
                const delivery = await send(text, { appendix: candidate?.appendix ?? '', data: result.data });
                log({ event: 'completed', elapsedMs: Date.now() - started, prepared: Boolean(candidate?.text), delivered: !delivery?.error && !delivery?.suppressed });
                settle({ handled: true, text:delivery?.renderedText ?? text, delivery, appendix: candidate?.appendix ?? '' });
                return true;
            } catch {
                log({ event: 'completion_failed', elapsedMs: Date.now() - started });
                // The media has a receipt. Do not let a failed text receipt turn
                // into another main-model claim that the media was not sent.
                settle({ handled: true, textFailed: true });
                return true;
            } finally {
                clearTimeout(timer); if (onAbort) prepSignal.removeEventListener('abort', onAbort);
                controller.abort();
            }
        },
        cancel() { cancelled = true; controller.abort(); },
    };
}

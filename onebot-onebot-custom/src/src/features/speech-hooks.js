import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { classifyMessageIntent } from '../turn-intent.js';
import { trustedFeatureContext } from '../feature-tools.js';
import { trustedServiceContext } from '../access/services.js';
import { resolveSpeechTarget } from './speech.js';
import { executeBusinessTool, speechFallbackForTurn } from './tools.js';
import { planSpeech, speechInstructions, splitSpeechReply, rememberServiceSpeech, serviceSpeechPlan, serviceSpeechOrigin } from './speech-policy.js';
const runFile = promisify(execFile);
const LUNCH_JOB_ID = '1b62b93f-77d4-543d-825c-12c774b3ebd4';
const LUNCH_SCRIPT = '/root/.openclaw/onebot-onebot-custom/scripts/lunch-prepare.mjs';

/** Cron replies use the same joint generation, then append only after text delivery. */
export function registerServiceSpeechHooks(api, { random = Math.random, execute = executeBusinessTool,
    serviceContext = trustedServiceContext, targetFor = resolveSpeechTarget, classify = classifyMessageIntent } = {}) {
    const pending = new Map();
    const key = (ctx, to, text) => `${ctx.sessionKey}:${ctx.accountId}:${to}:${createHash('sha256').update(text).digest('hex')}`;
    api.on('before_prompt_build', async (event, ctx) => {
        const context = serviceContext(ctx.sessionKey);
        if (!context) return;
        const previous = serviceSpeechPlan(ctx.sessionKey);
        const plan = previous && ctx.runId && previous.runId === ctx.runId ? previous : { ...planSpeech(context, await classify(event.prompt, false, '', { log: api.logger }), { random }), runId: ctx.runId };
        rememberServiceSpeech(ctx.sessionKey, plan);
        let lunchContext = '';
        if (context.originJobId === LUNCH_JOB_ID) {
            try {
                const output = await runFile(process.execPath, [LUNCH_SCRIPT], { timeout: 15000, maxBuffer: 100000 });
                const prepared = JSON.parse(output.stdout);
                if (prepared.status !== 'succeeded' || typeof prepared.dish !== 'string' || !prepared.dish) throw new Error('invalid lunch preparation result');
                lunchContext = `\n[午饭准备结果：已选菜品=${prepared.dish}。必须使用该菜品生成本次提醒。]\n`;
            } catch (error) {
                api.logger?.warn?.(`lunch preparation failed: ${String(error.message).slice(0, 200)}`);
                lunchContext = '\n[午饭准备结果：本次选菜和记录更新失败。不得虚构菜品，只发送未能完成推荐的简短提醒。]\n';
            }
        }
        return { appendSystemContext: speechInstructions(plan) + lunchContext };
    }, { timeoutMs: 30000 });
    api.on('message_sending', (event, ctx) => {
        if (ctx.channelId !== 'onebot') return;
        // Inbound replies pass this core hook before Gateway's final dispatcher.
        // Keep only its currently bound, valid appendix for Gateway to consume;
        // the actual QQ text is stripped by that dispatcher before publication.
        const inbound = trustedFeatureContext(ctx.sessionKey);
        const inboundTarget = inbound?.scope === 'group' ? `group:${inbound.groupId}` : `private:${inbound?.senderId}`;
        if (inbound?.speechAppendixSelected && inbound.accountId === ctx.accountId
            && String(event.to).replace(/^onebot:/u, '') === inboundTarget
            && splitSpeechReply(event.content, { appendix: true, token: inbound.speechToken }).appendix) return;
        // Cron delivery uses the destination conversation key, not the run key.
        // Recover only a live server-issued nonce, then recheck the registered
        // source and exact destination below; never infer service authority from a group.
        const origin = serviceSpeechOrigin(/\[\[VOICE_APPEND:([a-f0-9-]{36})\]\]/u.exec(event.content)?.[1]);
        const sourceKey = origin?.sessionKey ?? ctx.sessionKey;
        const context = serviceContext(sourceKey), plan = origin?.plan ?? serviceSpeechPlan(sourceKey);
        const split = splitSpeechReply(event.content, plan ?? {});
        if (!context || !plan) return split.text !== event.content ? { content: split.text } : undefined;
        const fallback = speechFallbackForTurn(sourceKey, context);
        const text = fallback ? fallback.fallbackText ? `${fallback.notice}\n\n${fallback.fallbackText}` : fallback.safeReply : split.text;
        if (plan.appendix && split.appendix && !fallback) {
            try {
                const target = targetFor(context);
                if (ctx.accountId !== target.accountId || event.to.replace(/^onebot:/u, '') !== `${target.target.type}:${target.target.id}`) return { content: text };
                for (const [id, item] of pending) if (item.expires < Date.now()) pending.delete(id);
                pending.set(key(ctx, event.to, text), { context, sourceKey, text: split.appendix, token: plan.token, expires: Date.now() + 120000 });
            } catch { /* unavailable target: send text only */ }
        }
        return { content: text };
    }, { priority: -500 });
    api.on('message_sent', async (event, ctx) => {
        if (ctx.channelId !== 'onebot') return;
        const id = key(ctx, event.to, event.content), item = pending.get(id);
        if (!item) return;
        pending.delete(id);
        if (!event.success || item.expires < Date.now()) return;
        try {
            await execute({ name: 'tts_synthesize', params: { text: item.text },
                context: { ...item.context, speechAppendix: true, requestId: `appendix:${item.token}` },
                callId: `appendix:${item.token}`, sessionKey: item.sourceKey });
        } catch { api.logger?.warn?.('Optional scheduled speech skipped; original text already delivered'); }
    });
}

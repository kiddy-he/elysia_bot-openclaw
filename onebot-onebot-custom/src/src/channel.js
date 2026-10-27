import { basename } from "node:path";
import { getDefaultContainerSharedDir, getDefaultSharedDir } from "./env.js";
import { listOneBotAccountIds, resolveOneBotAccount, applyOneBotAccountConfig } from "./config.js";
import { reactToMessage, sendForwardTransport, sendImageTransport as sendImage, sendRecordTransport as sendRecord, sendTextTransport as sendText, uploadFileTransport as uploadFile } from "./outbound.js";
import { startGateway } from "./gateway.js";
import { validateNativeDelivery, nativeDeliveryContext, acceptedPart, recordAcceptedPart } from "./delivery/queue.js";
import { scopedAgent } from "./workspaces/routes.js";
const DEFAULT_ACCOUNT_ID = "default";
const ONEBOT_MESSAGE_ACTIONS = ["react"];
function createActionResult(text, details) {
    return {
        content: [{ type: "text", text }],
        details,
    };
}
function parseTarget(to) {
    const normalized = to.replace(/^onebot:/i, "");
    if (normalized.startsWith("private:")) {
        return { type: "private", id: Number(normalized.slice(8)) };
    }
    if (normalized.startsWith("group:")) {
        return { type: "group", id: Number(normalized.slice(6)) };
    }
    return { type: "private", id: Number(normalized) };
}
export const onebotPlugin = {
    id: "onebot",
    meta: {
        id: "onebot",
        label: "OneBot",
        selectionLabel: "OneBot (QQ via NapCat)",
        docsPath: "/docs/channels/onebot",
        blurb: "Connect to QQ via OneBot 11 protocol (NapCat/go-cqhttp)",
        order: 55,
    },
    capabilities: {
        chatTypes: ["direct", "group"],
        media: true,
        reactions: true,
        threads: false,
        blockStreaming: true,
    },
    streaming: {
        blockStreamingCoalesceDefaults: {
            minChars: 80,
            idleMs: 600,
        },
    },
    reload: { configPrefixes: ["channels.onebot"] },
    messaging: {
        normalizeTarget: (target) => {
            return target.replace(/^onebot:/i, "");
        },
        targetResolver: {
            looksLikeId: (id) => {
                const normalized = id.replace(/^onebot:/i, "");
                if (normalized.startsWith("private:"))
                    return /^private:\d+$/.test(normalized);
                if (normalized.startsWith("group:"))
                    return /^group:\d+$/.test(normalized);
                return /^\d+$/.test(normalized);
            },
            hint: "private:<user_id> or group:<group_id>",
        },
    },
    config: {
        listAccountIds: (cfg) => listOneBotAccountIds(cfg),
        resolveAccount: (cfg, accountId) => resolveOneBotAccount(cfg, accountId),
        defaultAccountId: () => DEFAULT_ACCOUNT_ID,
        isConfigured: (account) => Boolean(account?.wsUrl && account?.httpUrl),
        describeAccount: (account) => ({
            accountId: account?.accountId ?? DEFAULT_ACCOUNT_ID,
            name: account?.name,
            enabled: account?.enabled ?? false,
            configured: Boolean(account?.wsUrl && account?.httpUrl),
        }),
    },
    setup: {
        validateInput: ({ input }) => {
            if (!input.token && !input.useEnv) {
                return "OneBot requires --token (format: wsUrl,httpUrl[,accessToken[,sharedDir[,containerSharedDir]]]) or --use-env (ONEBOT_WS_URL, ONEBOT_HTTP_URL)";
            }
            return null;
        },
        applyAccountConfig: ({ cfg, accountId, input }) => {
            let wsUrl = "";
            let httpUrl = "";
            let accessToken;
            const raw = input;
            let sharedDir = typeof raw.sharedDir === "string" && raw.sharedDir.trim()
                ? raw.sharedDir.trim()
                : undefined;
            let containerSharedDir = typeof raw.containerSharedDir === "string" && raw.containerSharedDir.trim()
                ? raw.containerSharedDir.trim()
                : undefined;
            if (input.token) {
                const parts = input.token.split(",");
                wsUrl = parts[0]?.trim() ?? "";
                httpUrl = parts[1]?.trim() ?? "";
                accessToken = parts[2]?.trim() || undefined;
                sharedDir ??= parts[3]?.trim() || undefined;
                containerSharedDir ??= parts[4]?.trim() || undefined;
            }
            if (!input.useEnv) {
                sharedDir ??= getDefaultSharedDir();
                containerSharedDir ??= getDefaultContainerSharedDir();
            }
            return applyOneBotAccountConfig(cfg, accountId, {
                wsUrl,
                httpUrl,
                accessToken,
                sharedDir,
                containerSharedDir,
                name: input.name,
            });
        },
    },
    outbound: {
        deliveryMode: "direct",
        textChunkLimit: 4500,
        sendPayload: async ({ to, payload, accountId, cfg }) => {
            const tag = payload.channelData?.onebotDelivery;
            if (!tag) {
                // Legacy/core producers still use the same native durable lifecycle.
                if (payload.mediaUrl || payload.mediaUrls?.length) throw new Error('媒体缺少业务来源与当前请求授权，未投递附件。');
                return onebotPlugin.outbound.sendText({ to, text: payload.text, accountId, cfg });
            }
            const part = validateNativeDelivery(tag.id, tag.index, accountId ?? 'default', to);
            const previousMessageId = acceptedPart(tag.id, tag.index);
            if (previousMessageId) return { channel: 'onebot', messageId: previousMessageId };
            const account = { ...resolveOneBotAccount(cfg, accountId), deliveryAdmission: () => validateNativeDelivery(tag.id, tag.index, accountId ?? 'default', to) };
            const target = parseTarget(to);
            if (part.type === 'text') {
                const result = await sendText({ to, text: part.text, account, rewritePersona: false, durableRendered: true, mentions: part.mentions, ...nativeDeliveryContext(tag.id, tag.index, accountId ?? 'default', to) });
                if (result.error || !result.messageId) throw new Error(result.error || 'missing platform receipt');
                recordAcceptedPart(tag.id, tag.index, result.messageId);
                return result;
            }
            const result = part.type === 'forward' ? await sendForwardTransport(account,target.type,target.id,part.nodes)
                : part.type === 'image' ? await sendImage(account, target.type, target.id, part.path, part.caption)
                : part.type === 'record' ? await sendRecord(account, target.type, target.id, part.path)
                : await uploadFile(account, target.type, target.id, part.path, part.fileName ?? basename(part.path));
            const receiptId = result.data?.message_id ?? (part.type === 'file' ? result.data?.file_id : undefined);
            if (receiptId == null) throw new Error('missing platform receipt');
            recordAcceptedPart(tag.id, tag.index, receiptId);
            return { channel: 'onebot', messageId: String(receiptId), ...(result.data?.file_id && !result.data?.message_id ? { fileId: String(result.data.file_id) } : {}) };
        },
        sendText: async ({ to, text, accountId, replyToId, cfg }) => {
            const account = resolveOneBotAccount(cfg, accountId);
            const workspaceAgentId = scopedAgent({ scope: 'automation', conversationId: 'public', roleAgentId: accountId === 'yuexia' ? 'onebot-yuexia' : 'main' });
            const result = await sendText({ to, text, accountId, replyToId, account, workspaceAgentId });
            if (result.error) {
                throw new Error(result.error);
            }
            if (!result.messageId) {
                throw new Error("OneBot sendText did not return a messageId");
            }
            return {
                channel: "onebot",
                messageId: result.messageId,
            };
        },
        sendMedia: async () => {
            throw new Error('媒体必须经已授权业务产物与统一持久投递入口发送。');
        },
    },
    actions: {
        describeMessageTool: ({ cfg }) => {
            const account = resolveOneBotAccount(cfg);
            if (!account.enabled || !account.wsUrl || !account.httpUrl) {
                return null;
            }
            return {
                actions: [...ONEBOT_MESSAGE_ACTIONS],
            };
        },
        supportsAction: ({ action }) => action === "react",
        handleAction: async ({ action, cfg, params, accountId, toolContext }) => {
            if (action !== "react") {
                return createActionResult(`Unsupported OneBot action: ${action}`, {
                    ok: false,
                    channel: "onebot",
                    action,
                    error: `Unsupported OneBot action: ${action}`,
                });
            }
            const messageId = params.message_id ??
                params.messageId ??
                params.message ??
                toolContext?.currentMessageId;
            const emojiId = params.emoji_id ??
                params.emojiId ??
                params.emoji ??
                params.reaction;
            if (messageId == null || emojiId == null || String(emojiId).trim() === "") {
                return createActionResult("OneBot react requires `emoji` and `message_id` (or current message context).", {
                    ok: false,
                    channel: "onebot",
                    action,
                    error: "OneBot react requires `emoji` and `message_id` (or current message context).",
                });
            }
            const account = resolveOneBotAccount(cfg, accountId);
            const result = await reactToMessage(account, messageId, emojiId);
            if (!result.ok) {
                return createActionResult(result.error ?? "OneBot reaction failed", {
                    ok: false,
                    channel: "onebot",
                    action,
                    error: result.error ?? "OneBot reaction failed",
                    data: result,
                });
            }
            return createActionResult(`Reacted with ${String(emojiId)} to message ${String(messageId)}.`, {
                ok: true,
                channel: "onebot",
                action,
                data: result,
            });
        },
    },
    gateway: {
        startAccount: async (ctx) => {
            const { account, abortSignal, log, cfg } = ctx;
            log?.info(`[onebot:${account.accountId}] Starting gateway`);
            await startGateway({
                account,
                abortSignal,
                cfg,
                log,
                onReady: () => {
                    log?.info(`[onebot:${account.accountId}] Gateway ready`);
                    ctx.setStatus({
                        ...ctx.getStatus(),
                        running: true,
                        connected: true,
                        lastConnectedAt: Date.now(),
                    });
                },
                onError: (error) => {
                    log?.error(`[onebot:${account.accountId}] Gateway error: ${error.message}`);
                    ctx.setStatus({
                        ...ctx.getStatus(),
                        connected: false,
                        lastError: error.message,
                    });
                },
            });
        },
    },
    status: {
        defaultRuntime: {
            accountId: DEFAULT_ACCOUNT_ID,
            running: false,
            connected: false,
            lastConnectedAt: null,
            lastError: null,
        },
        buildAccountSnapshot: ({ account, runtime }) => ({
            accountId: account?.accountId ?? DEFAULT_ACCOUNT_ID,
            name: account?.name,
            enabled: account?.enabled ?? false,
            configured: Boolean(account?.wsUrl && account?.httpUrl),
            running: runtime?.running ?? false,
            connected: runtime?.connected ?? false,
            lastConnectedAt: runtime?.lastConnectedAt ?? null,
            lastError: runtime?.lastError ?? null,
        }),
    },
};

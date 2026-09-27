import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { extensionForMime, readRemoteMediaBuffer } from "openclaw/plugin-sdk/media-runtime";
import { getDefaultContainerSharedDir, getDefaultSharedDir } from "./env.js";
import { listOneBotAccountIds, resolveOneBotAccount, applyOneBotAccountConfig } from "./config.js";
import { reactToMessage, sendImage, sendRecord, sendText, uploadFile } from "./outbound.js";
import { startGateway } from "./gateway.js";
const DEFAULT_ACCOUNT_ID = "default";
const ONEBOT_MESSAGE_ACTIONS = ["react"];
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic", ".heif"]);
const AUDIO_EXTS = new Set([".mp3", ".ogg", ".wav", ".m4a", ".aac", ".flac", ".amr", ".silk", ".opus"]);
const REMOTE_MEDIA_MAX_BYTES = 25 * 1024 * 1024;
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
function resolveLocalMediaPath(mediaUrl) {
    if (!mediaUrl || !mediaUrl.trim()) {
        throw new Error("OneBot sendMedia requires mediaUrl");
    }
    if (mediaUrl.startsWith("file://")) {
        return fileURLToPath(mediaUrl);
    }
    return isAbsolute(mediaUrl) ? mediaUrl : resolvePath(mediaUrl);
}
async function resolveOutboundMedia(mediaUrl) {
    const trimmed = mediaUrl.trim();
    if (!/^https?:\/\//i.test(trimmed)) {
        return { path: resolveLocalMediaPath(trimmed) };
    }
    const media = await readRemoteMediaBuffer({
        url: trimmed,
        maxBytes: REMOTE_MEDIA_MAX_BYTES,
        maxRedirects: 5,
        timeoutMs: 30000,
        responseHeaderTimeoutMs: 15000,
        readIdleTimeoutMs: 15000,
    });
    const contentType = media.contentType?.split(";")[0]?.trim().toLowerCase();
    if (!contentType?.startsWith("image/") && !contentType?.startsWith("audio/")) {
        throw new Error(`OneBot remote media must be an image or audio file, received ${contentType || "unknown content type"}`);
    }
    const extension = extensionForMime(contentType)
        || extname(media.fileName ?? new URL(trimmed).pathname).toLowerCase()
        || ".bin";
    const tempDir = await mkdtemp(join(tmpdir(), "openclaw-onebot-media-"));
    const mediaPath = join(tempDir, `remote${extension}`);
    try {
        await writeFile(mediaPath, media.buffer, { mode: 0o600 });
        return {
            path: mediaPath,
            contentType,
            cleanup: () => rm(tempDir, { recursive: true, force: true }),
        };
    }
    catch (err) {
        await rm(tempDir, { recursive: true, force: true }).catch(() => { });
        throw err;
    }
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
        sendText: async ({ to, text, accountId, replyToId, cfg }) => {
            const account = resolveOneBotAccount(cfg, accountId);
            const result = await sendText({ to, text, accountId, replyToId, account });
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
        sendMedia: async ({ to, text, mediaUrl, accountId, cfg }) => {
            const account = resolveOneBotAccount(cfg, accountId);
            const target = parseTarget(to);
            const media = await resolveOutboundMedia(mediaUrl ?? "");
            try {
                const ext = extname(media.path).toLowerCase();
                let mediaResult;
                if (media.contentType?.startsWith("audio/") || AUDIO_EXTS.has(ext)) {
                    mediaResult = await sendRecord(account, target.type, target.id, media.path);
                }
                else if (media.contentType?.startsWith("image/") || IMAGE_EXTS.has(ext)) {
                    mediaResult = await sendImage(account, target.type, target.id, media.path);
                }
                else {
                    mediaResult = await uploadFile(account, target.type, target.id, media.path, basename(media.path));
                }
                const caption = (text ?? "").trim() || "内容已经送到啦，请舰长查收♪";
                const textResult = await sendText({ to, text: caption, accountId, account });
                if (textResult.error) {
                    throw new Error(textResult.error);
                }
                const textMessageId = textResult.messageId;
                const mediaMessageId = mediaResult?.data && typeof mediaResult.data === "object" && "message_id" in mediaResult.data
                    ? String(mediaResult.data.message_id)
                    : undefined;
                return {
                    channel: "onebot",
                    messageId: mediaMessageId ?? textMessageId ?? `${Date.now()}`,
                };
            }
            finally {
                await media.cleanup?.().catch(() => { });
            }
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

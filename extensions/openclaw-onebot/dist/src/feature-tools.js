import { BACKEND_FEATURES, authorizeFeature, automationFeatureEnabled, featureIdentity, loadFeatureConfig } from "./feature-policy.js";
import { resolve } from "node:path";
import { authorizeServiceTool, trustedServiceContext, loadServiceRegistry } from "./access/services.js";
import { executorSettings } from "./features/settings.js";
import { BUSINESS_TOOLS } from "./features/catalog.js";

const turns = new Map();
export function trustedFeatureContext(sessionKey) {
    const active = turns.get(String(sessionKey));
    return active?.size === 1 ? [...active.values()][0] : null;
}

/** Context comes from the actual OneBot event, never from model tool arguments. */
export function bindFeatureTurn(sessionKey, context) {
    const token = Symbol("onebot feature turn");
    const active = turns.get(sessionKey) ?? new Map();
    active.set(token, Object.freeze({ ...context }));
    turns.set(sessionKey, active);
    return () => {
        active.delete(token);
        if (!active.size && turns.get(sessionKey) === active) turns.delete(sessionKey);
    };
}

const SCRIPT_RULES = [
    { match: /agy-proxy-diagnose\.sh\s+["']?(quota|refresh)\b/u, feature: "quota", action: (m) => m[1] === "quota" ? "query" : "refresh" },
    { match: /agy-proxy-diagnose\.sh\s+["']?(image-edit(?:-reference)?|image-generate|official-image-generate(?:-multi)?)\b/u, feature: "images", action: (m) => m[1].startsWith("image-edit") ? "edit" : m[1].startsWith("official") ? "reference" : "generate" },
    { match: /agy-proxy-diagnose\.sh\b/u, feature: "system", action: "tools" },
    { match: /adsb_query\.sh\b/u, feature: "adsb", action: "read" },
    { match: /alas-diagnose\.sh\b/u, feature: "alas", action: "read" },
    { match: /alas-screen-qq\/scripts\/(?:capture|send)\.sh\b/u, feature: "alas", action: "screenshot" },
    { match: /alas-monitor\.sh\b/u, feature: "alas", action: "control" },
    { match: /qbtctl\.sh\s+["']?(status|list|info|login-check)\b/u, feature: "downloads", action: "read" },
    { match: /qbtctl\.sh\b/u, feature: "downloads", action: "control" },
    { match: /qzone-cli\.mjs[\s\S]*?\b(msglist|feeds)\b/u, feature: "qzone", action: "read" },
    { match: /qzone-cli\.mjs[\s\S]*?\b(publish|delete)\b/u, feature: "qzone", action: "publish" },
    { match: /qzone-cli\.mjs\b/u, feature: "qzone", action: "interact" },
    { match: /qzone-daily\.mjs\b/u, feature: "qzone", action: "publish" },
    { match: /(?:Microsoft-Rewards-Script|skills\/microsoft-rewards)\b/u, feature: "rewards", action: "control" },
    { match: /(?:openclash|clashctl|openwrt_router)\b/u, feature: "network", action: "control" },
];

export function classifyFeatureTool(toolName, params = {}) {
    if (BUSINESS_TOOLS[toolName]) return { feature: BUSINESS_TOOLS[toolName].feature, action: BUSINESS_TOOLS[toolName].action, unrestricted: false, dedicated: true };
    if (toolName === "web_search" || toolName === "web_fetch") return { feature: "search", action: "web", unrestricted: toolName === "web_fetch" };
    if (toolName === "automations") return { feature: "automation", action: "manage", unrestricted: true };
    if (toolName === "message" || toolName === "tts") return { feature: "system", action: "deliver", unrestricted: true };
    if (toolName === "exec") {
        const command = String(params.command ?? params.cmd ?? "");
        const rule = SCRIPT_RULES.find((item) => item.match.test(command));
        if (rule) return { feature: rule.feature, action: typeof rule.action === "function" ? rule.action(rule.match.exec(command)) : rule.action, unrestricted: true };
    }
    return { feature: "system", action: "tools", unrestricted: true };
}
export function availableBusinessTools(context) {
    try {
        const config = loadFeatureConfig(), settings = executorSettings();
        return Object.entries(BUSINESS_TOOLS).filter(([name]) => settings[name].enabled && decideFeatureTool(config, name, {}, context).allowed)
            .map(([name, specification]) => ({ name, feature: specification.feature, action: specification.action }));
    } catch { return []; }
}


/** Raw shell/read/write tools can reach any module; only permit them when the
 * sender has the full backend grant. This prevents bypass via alternate scripts,
 * imports, curl, Python, or compound commands when a module is restricted.
 * Narrow guest quota/images are executed by Gateway fixed handlers, not tools.
 */
export function decideFeatureTool(config, toolName, params, context) {
    if(context.xOperation && !['x','conversation'].includes(BUSINESS_TOOLS[toolName]?.feature)) return {allowed:false,reason:'x_dedicated_tools_only'};
    if(context.xhsRecoveryOnly && BUSINESS_TOOLS[toolName]?.feature!=='xiaohongshu')return {allowed:false,reason:'xhs_recovery_tools_only'};
    if (context.xiaohongshuOperation && !['xiaohongshu','conversation'].includes(BUSINESS_TOOLS[toolName]?.feature))
        return {allowed:false,reason:'xiaohongshu_dedicated_tools_only'};
    if (BUSINESS_TOOLS[toolName]?.feature === 'reminders'
        && !(toolName === 'reminder_list' ? ['list', 'cancel'].includes(context.reminderAction) : context.reminderAction === BUSINESS_TOOLS[toolName].action))
        return { allowed: false, reason: 'no_current_reminder_intent' };
    if (toolName === 'tts' || toolName === 'exec' && /(?:run_elysia\.py|elysia-tts\/scripts\/synthesize\.py)/u.test(String(params?.command ?? params?.cmd ?? '')))
        return { allowed: false, reason: 'use_authorized_speech_tool' };
    if (toolName === 'tts_synthesize' && (context.accountId !== 'default' || context.speechMode === 'ordinary' && context.speechAppendix !== true))
        return { allowed: false, reason: 'elysia_speech_only_or_no_explicit_request' };
    if (toolName === "image_generate") return { allowed: false, reason: "use_onebot_image_generate_pipeline" };
    if (context.internal) return { allowed: false, reason: "internal_no_tools" };
    if (Array.isArray(context.allowedReadPaths)) {
        const path = String(params?.path ?? params?.file_path ?? "");
        if (toolName !== "read" || !path || !context.allowedReadPaths.some((allowed) => resolve(allowed) === resolve(path)))
            return { allowed: false, reason: "vision_reference_paths_only" };
        return authorizeFeature(config, "conversation", "media", context);
    }
    // Member web search is native grounding, not a grant to arbitrary web_fetch
    // or localhost requests. Images/quota likewise use fixed Gateway handlers.
    const target = classifyFeatureTool(toolName, params);
    if (featureIdentity(config, context) !== "admin") {
        // Image guests retain the bounded parser, cooldown and fixed workflow.
        // Other dedicated executors can be delegated by their action profile.
        if (!target.dedicated || target.feature === "images") return { allowed: false, reason: "fixed_handlers_only" };
    }
    const decision = authorizeFeature(config, target.feature, target.action, context);
    if (!decision.allowed) return decision;
    if (target.unrestricted) {
        const reachable = [...BACKEND_FEATURES, "images", "quota", "search"];
        for (const id of reachable) {
            for (const action of Object.keys(config.features[id].actions)) {
                if (!authorizeFeature(config, id, action, context).allowed)
                    return { allowed: false, reason: "unrestricted_tools_require_full_backend", feature: id, action };
            }
        }
    }
    return decision;
}

export function registerFeatureToolGuard(api) {
    api.on("before_tool_call", (event, ctx) => {
        const sessionKey = String(ctx.sessionKey ?? "");
        const active = turns.get(sessionKey);
        if (!active && /:cron:/u.test(sessionKey)) {
            try {
                const config = loadFeatureConfig();
                const entry = Object.entries(config.automationBindings).find(([id]) => sessionKey.includes(`:cron:${id}`));
                if (!entry) return { block: true, blockReason: "定时任务缺少已登记的服务授权。" };
                const binding = entry[1];
                if (!BUSINESS_TOOLS[event.toolName]) return { block: true, blockReason: "定时服务仅允许已登记的专用业务工具。" };
                if (BUSINESS_TOOLS[event.toolName] && !authorizeServiceTool(trustedServiceContext(sessionKey), BUSINESS_TOOLS[event.toolName], config)) return { block: true, blockReason: "定时任务无该工具的服务授权。" };
                if (BUSINESS_TOOLS[event.toolName]?.speech === true) return;
                const target = classifyFeatureTool(event.toolName, event.params);
                if (!binding.enabled || !config.features[binding.feature].enabled || target.feature !== binding.feature || !automationFeatureEnabled(config, target.feature, target.action))
                    return { block: true, blockReason: "定时任务所属功能或调用动作已停用。" };
            }
            catch { return { block: true, blockReason: "定时任务功能配置不可用。" }; }
            return;
        }
        const isOneBot = /:onebot:/u.test(sessionKey) || ctx.requester?.channel === "onebot";
        if (!active && !isOneBot) return;
        if (!active || active.size !== 1)
            return { block: true, blockReason: "工具执行失败：OneBot 功能权限拒绝。当前调用缺少唯一可信发送者上下文，未执行该工具；这段文字是错误信息，不是文件内容或执行结果。" };
        const context = [...active.values()][0];
        const requester = ctx.requester;
        if ((requester?.senderId != null && String(requester.senderId) !== String(context.senderId))
            || (requester?.accountId != null && String(requester.accountId) !== String(context.accountId)))
            return { block: true, blockReason: "OneBot 功能权限：工具调用身份与入站消息不一致。" };
        try {
            const decision = decideFeatureTool(loadFeatureConfig(), event.toolName, event.params, context);
            if (!decision.allowed)
                return { block: true, blockReason: `OneBot 功能权限：${decision.feature ?? "backend"}.${decision.action ?? "tools"} 当前不可用（${decision.reason}）。` };
        }
        catch {
            return { block: true, blockReason: "OneBot 功能配置不可用，已禁止后台工具。" };
        }
    }, { priority: 1000 });
}

export function registerFeatureOutboundGuard(api) {
    api.on("message_sending", (event, ctx) => {
        if (ctx.channelId !== "onebot" || !/:cron:/u.test(String(ctx.sessionKey ?? ""))) return;
        try {
            const config = loadFeatureConfig();
            const entry = Object.entries(config.automationBindings).find(([id]) => ctx.sessionKey.includes(`:cron:${id}`));
            if (!entry) return { cancel: true, cancelReason: "定时任务缺少已登记的投递授权。" };
            const binding = entry[1];
            const subject = loadServiceRegistry().jobs[entry[0]];
            if (!subject || (subject.accountId && subject.accountId !== (ctx.accountId ?? 'default')) || (subject.kind === 'agent' && !String(ctx.sessionKey).startsWith(`agent:${subject.agentId}:`))) return { cancel: true, cancelReason: "定时任务机器人账号与服务授权不一致。" };
            const feature = config.features[binding.feature];
            const to = String(event.to).replace(/^onebot:/u, "");
            if (to.startsWith("private:") && !config.accounts[ctx.accountId ?? "default"]?.privateAdminIds.includes(to.slice(8))) return { cancel: true, cancelReason: "定时服务未授权向该私聊用户投递。" };
            if (!binding.enabled || !feature.enabled
                || (binding.deliveryGroupIds.length > 0 && !binding.deliveryGroupIds.some((id) => to === `group:${id}`))
                || (to.startsWith("group:") && (!binding.deliveryGroupIds.includes(to.slice(6)) || !feature.groupIds.includes(to.slice(6)))))
                return { cancel: true, cancelReason: "定时任务功能或目标群已停用。" };
        }
        catch { return { cancel: true, cancelReason: "功能配置不可用，暂停定时消息投递。" }; }
    }, { priority: 1000 });
}

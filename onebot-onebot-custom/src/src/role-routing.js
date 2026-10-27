import { onebotPath } from "./paths.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configuredRoleGroups, loadFeatureConfig } from "./feature-policy.js";

export const ROLE_ROUTING_PATH = onebotPath("onebot-role-routing.json");

function expandHomePath(value) {
    const raw = String(value ?? "").trim();
    return raw.startsWith("~/") ? join(process.env.HOME ?? "/root", raw.slice(2)) : raw;
}

function loadPeerSoul(pathValue) {
    const path = expandHomePath(pathValue);
    if (!path)
        return "";
    try {
        return readFileSync(path, "utf8").trim().slice(0, 8000);
    }
    catch {
        return "";
    }
}

export function loadRoleRouting(path = ROLE_ROUTING_PATH) {
    const defaults = {
        groups: [],
        adminIds: [],
        roles: {
            elysia: {
                agentId: "main",
                peerAgentId: "onebot-elysia-peer",
                peerSoulPath: "~/.openclaw/workspace/PEER_SOUL.md",
                accountId: "default",
                displayName: "爱莉希雅",
                allowNsfw: true,
                names: ["爱莉希雅", "爱莉"],
                selfIds: [],
            },
            yuexia: {
                agentId: "onebot-yuexia",
                peerAgentId: "onebot-yuexia-peer",
                peerSoulPath: "~/.openclaw/workspace/onebot-yuexia/PEER_SOUL.md",
                accountId: "yuexia",
                displayName: "月下初拥",
                allowNsfw: false,
                names: ["月下初拥", "月下"],
                selfIds: [],
            },
        },
    };
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        const roles = {};
        for (const [roleId, role] of Object.entries({ ...defaults.roles, ...(parsed.roles ?? {}) })) {
            if (!role || typeof role !== "object")
                continue;
            const agentId = String(role.agentId ?? "").trim();
            const accountId = String(role.accountId ?? "").trim();
            if (!agentId || !accountId)
                continue;
            roles[roleId] = {
                enabled: role.enabled !== false,
                agentId,
                peerAgentId: String(role.peerAgentId ?? "").trim(),
                peerSoulPath: String(role.peerSoulPath ?? "").trim(),
                peerSoul: loadPeerSoul(role.peerSoulPath),
                accountId,
                displayName: String(role.displayName ?? roleId).trim(),
                allowNsfw: role.allowNsfw !== false,
                names: Array.isArray(role.names) ? role.names.map(String).map((value) => value.trim()).filter(Boolean) : [],
                selfIds: Array.isArray(role.selfIds) ? role.selfIds.map(String).map((value) => value.trim()).filter(Boolean) : [],
            };
        }
        // Production authorization lives in onebot-features.json. Explicit
        // fixture paths keep the standalone role routing tests independent.
        const featureConfig = path === ROLE_ROUTING_PATH ? loadFeatureConfig() : null;
        return {
            groups: featureConfig ? configuredRoleGroups(featureConfig) : parsed.groups ?? defaults.groups,
            adminIds: featureConfig ? [...featureConfig.identities.adminIds] : Array.isArray(parsed.adminIds) ? parsed.adminIds.map(String).map((value) => value.trim()).filter(Boolean) : defaults.adminIds,
            roles,
        };
    }
    catch {
        return defaults;
    }
}

export function groupRoleIds(routing, groupId) {
    const normalized = String(groupId);
    if (Array.isArray(routing.groups)) {
        return routing.groups.includes(normalized) ? Object.keys(routing.roles) : [];
    }
    const entry = routing.groups?.[normalized];
    if (Array.isArray(entry))
        return entry.map(String);
    if (entry && typeof entry === "object" && Array.isArray(entry.roles))
        return entry.roles.map(String);
    return [];
}

export function groupRequireMention(routing, groupId) {
    const normalized = String(groupId);
    const entry = routing.groups?.[normalized];
    return Boolean(entry && typeof entry === "object" && !Array.isArray(entry) && entry.requireMention === true);
}

export function selectGroupRoles({ routing, groupId, atIds = [], text = "", isRoleAvailable = () => true, resolveRoleAgentId = () => "" }) {
    const allowedRoleIds = new Set(groupRoleIds(routing, groupId));
    const roles = Object.entries(routing.roles)
        .filter(([roleId]) => allowedRoleIds.has(roleId))
        .map(([, role]) => role)
        .filter((role) => isRoleAvailable(role));
    if (roles.length === 0)
        return { targets: [], explicit: false, requireMention: false, mentionedIds: [] };
    const ids = new Set((Array.isArray(atIds) ? atIds : []).map((id) => String(id ?? "")).filter(Boolean));
    const value = String(text ?? "");
    const requireMention = groupRequireMention(routing, groupId);
    const atMentioned = roles.filter((role) => role.selfIds.some((id) => ids.has(id))
        || [...ids].some((id) => resolveRoleAgentId(id) === role.agentId));
    // Selecting another role's voice does not select that role as a speaker.
    let addresseeText = value;
    for (const name of roles.flatMap(role => role.names).filter(Boolean).sort((a, b) => b.length - a.length)) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
        addresseeText = addresseeText.replace(new RegExp(`(?:使用|采用|用)\\s*${escaped}\\s*(?:的\\s*)?(?:声线|音色|声音)`, 'gu'), '');
    }
    const nameMentioned = roles.filter((role) => role.names.some((name) => name && addresseeText.includes(name)));
    const explicit = requireMention
        ? atMentioned
        : roles.filter((role) => atMentioned.includes(role) || nameMentioned.includes(role));
    return {
        targets: explicit.length > 0 ? explicit : requireMention ? [] : roles,
        explicit: explicit.length > 0,
        requireMention,
        mentionedIds: [...ids],
    };
}

export function selectGroupReplyInstruction({ isGroup, peerFollowup, isGroupAdmin, senderName = "" }) {
    if (!isGroup || peerFollowup)
        return "";
    const name = String(senderName ?? "").trim();
    if (isGroupAdmin === true)
        return "本次回复发送到 QQ 群聊，群内其他成员也会看到。发送者是 admin（舰长）；可以自然称呼对方为“舰长”，但内容要符合群聊公开场合，不要把私聊专属内容带进群聊。";
    return `本次回复发送到 QQ 群聊，群内其他成员也会看到。发送者只是普通群友${name ? `（昵称：${name}）` : ""}，既不是 admin，也不是“舰长”；不要称呼对方为“舰长”，不要使用对舰长的亲昵、撒娇或占有欲口吻，用对方昵称或自然称呼，保持角色应有的礼貌与边界。`;
}

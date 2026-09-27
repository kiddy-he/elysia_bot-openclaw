import { readFileSync } from "node:fs";
import { join } from "node:path";

export const ROLE_ROUTING_PATH = join(process.env.HOME ?? "/root", ".openclaw", "onebot-role-routing.json");

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
        return {
            groups: parsed.groups ?? defaults.groups,
            adminIds: Array.isArray(parsed.adminIds) ? parsed.adminIds.map(String).map((value) => value.trim()).filter(Boolean) : defaults.adminIds,
            roles,
        };
    }
    catch {
        return defaults;
    }
}

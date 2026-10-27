import { cleanConversationText, cleanDisplayName } from './text-boundary.js';
const DEFAULT_MAX_ENTRIES = 30;
const DEFAULT_MAX_GROUPS = 24;
const DEFAULT_MESSAGE_MAX_CHARS = 160;
const DEFAULT_WINDOW = 12;
const HISTORY_CUT_MARKERS = [
    "[[OPENCLAW",
    "[Group ",
    "[Recent conversation summary]",
    "[内部上下文协议",
];

export function sanitizeGroupHistoryText(value, maxChars = DEFAULT_MESSAGE_MAX_CHARS) {
    let text = cleanConversationText(value).replace(/\s+/gu, " ").trim();
    if (!text)
        return "";
    for (const marker of HISTORY_CUT_MARKERS) {
        const index = text.indexOf(marker);
        if (index >= 0)
            text = text.slice(0, index).trim();
    }
    if (!text)
        return "";
    if (maxChars > 0 && text.length > maxChars)
        text = `${text.slice(0, maxChars)}…`;
    return text;
}

function formatHistoryTime(ms) {
    const date = new Date(Number(ms));
    if (Number.isNaN(date.getTime()))
        return "";
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${hours}:${minutes}`;
}

export function createGroupHistory({ maxEntries = DEFAULT_MAX_ENTRIES, maxGroups = DEFAULT_MAX_GROUPS, messageMaxChars = DEFAULT_MESSAGE_MAX_CHARS } = {}) {
    const store = new Map();
    const record = (groupId, entry = {}) => {
        const key = String(groupId ?? "").trim();
        const text = sanitizeGroupHistoryText(entry.text, messageMaxChars);
        if (!key || !text)
            return false;
        const list = store.get(key) ?? [];
        list.push({
            messageId: String(entry.messageId ?? ""),
            senderId: String(entry.senderId ?? ""),
            senderName: cleanDisplayName(entry.senderName, entry.senderId ?? ''),
            isAdmin: entry.isAdmin === true,
            text,
            time: Number(entry.time) > 0 ? Number(entry.time) : Date.now(),
        });
        if (list.length > maxEntries)
            list.splice(0, list.length - maxEntries);
        store.set(key, list);
        while (store.size > maxGroups) {
            let oldestKey = null;
            let oldestTime = Infinity;
            for (const [candidate, entries] of store) {
                const latest = entries.length > 0 ? entries[entries.length - 1].time : 0;
                if (latest < oldestTime) {
                    oldestTime = latest;
                    oldestKey = candidate;
                }
            }
            if (oldestKey === null)
                break;
            store.delete(oldestKey);
        }
        return true;
    };
    const snapshot = (groupId, { limit = DEFAULT_WINDOW, excludeMessageIds = [] } = {}) => {
        const list = store.get(String(groupId ?? "").trim()) ?? [];
        const exclude = new Set((Array.isArray(excludeMessageIds) ? excludeMessageIds : []).map((id) => String(id)));
        const windowSize = Math.max(1, Number(limit) || DEFAULT_WINDOW);
        return list
            .filter((entry) => !entry.messageId || !exclude.has(entry.messageId))
            .slice(-windowSize);
    };
    const formatContext = (groupId, { limit = DEFAULT_WINDOW, excludeMessageIds = [] } = {}) => {
        const entries = snapshot(groupId, { limit, excludeMessageIds });
        if (entries.length === 0)
            return "";
        const lines = entries.map((entry) => {
            const name = entry.isAdmin ? `${entry.senderName}[admin]` : entry.senderName;
            const time = formatHistoryTime(entry.time);
            return `${time ? `${time} ` : ""}${name}: ${entry.text}`;
        });
        return `\n[最近群消息（只读背景，用于理解群里的气氛，不必逐条回应或复述，可自然参考其中话题）：\n${lines.join("\n")}\n]`;
    };
    return {
        record,
        snapshot,
        formatContext,
        size: () => store.size,
    };
}

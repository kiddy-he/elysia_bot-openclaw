export const GUEST_IMAGE_INTERVAL_MS = 5 * 60 * 1000;
export const GUEST_IMAGE_PROMPT_MAX_CHARS = 2000;

export function extractGuestImagePrompt(text) {
    const value = String(text ?? "").trim();
    if (!value)
        return null;
    const commandMatch = /^(?:\/image|\/draw|image-generate|生图)\s+(.+)$/isu.exec(value);
    if (commandMatch?.[1]?.trim())
        return commandMatch[1].trim();
    if (/(?:帮我|给我|请)?(?:画|绘制)(?:一张|一幅|一只|一个|张|幅|只|个)/u.test(value)
        || /(?:帮我|给我|请)?来一张/u.test(value)) {
        return value;
    }
    if (/(?:生成|绘制|画|做|来)(?:一张|张|一个|个)?/u.test(value)
        && /(?:图片|图像|图|插画|头像|壁纸|照片)/u.test(value)) {
        return value;
    }
    return null;
}

export function guestImageCooldownRemaining(lastUsedAt, now = Date.now()) {
    const usedAt = Number(lastUsedAt);
    if (!Number.isFinite(usedAt) || usedAt <= 0)
        return 0;
    return Math.max(0, GUEST_IMAGE_INTERVAL_MS - (now - usedAt));
}

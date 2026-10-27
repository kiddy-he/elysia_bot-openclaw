import { onebotPath } from "./paths.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const APP_CONFIG_PATH = onebotPath("onebot-app-config.json");
const DEFAULT_APP_CONFIG = Object.freeze({
    batchGapMs: 1500,
    batchMaxMessages: 12,
    batchMaxChars: 50000,
    defaultResponseTimeoutMs: 180000,
    modelReplyTimeoutMs: 180000,
    imageAnalysisResponseTimeoutMs: 250000,
    imageResponseTimeoutMs: 3600000,
    extendedResponseTimeoutMs: 900000,
    // Legacy config field retained for older configuration files; guest chat
    // no longer applies a per-minute admission or reply cooldown.
    guestReplyIntervalMs: 0,
});

export function loadAppConfig(path = APP_CONFIG_PATH) {
    let config;
    try {
        config = JSON.parse(readFileSync(path, "utf8"));
    }
    catch (error) {
        if (error?.code === "ENOENT")
            return DEFAULT_APP_CONFIG;
        throw error;
    }
    const bounds = {
        batchGapMs: [1, 10000],
        batchMaxMessages: [1, 100],
        batchMaxChars: [100, 200000],
        defaultResponseTimeoutMs: [1000, 3600000],
        modelReplyTimeoutMs: [1000, 600000],
        imageAnalysisResponseTimeoutMs: [1000, 3600000],
        imageResponseTimeoutMs: [1000, 3600000],
        extendedResponseTimeoutMs: [1000, 3600000],
        guestReplyIntervalMs: [0, 3600000],
    };
    config.modelReplyTimeoutMs ??= DEFAULT_APP_CONFIG.modelReplyTimeoutMs;
    config.extendedResponseTimeoutMs ??= DEFAULT_APP_CONFIG.extendedResponseTimeoutMs;
    config.guestReplyIntervalMs ??= 0;
    for (const [key, [min, max]] of Object.entries(bounds)) {
        if (!Number.isSafeInteger(config[key]) || config[key] < min || config[key] > max)
            throw new Error(`Invalid OneBot app config: ${key} must be an integer between ${min} and ${max}`);
    }
    if (config.extendedResponseTimeoutMs <= Math.max(config.defaultResponseTimeoutMs, config.imageAnalysisResponseTimeoutMs, 255000))
        throw new Error('Extended response timeout must exceed all non-image progress intervals');
    return Object.freeze(Object.fromEntries(Object.keys(bounds).map((key) => [key, config[key]])));
}

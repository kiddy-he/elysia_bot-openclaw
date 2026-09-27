import { readFileSync } from "node:fs";
import { join } from "node:path";

export const APP_CONFIG_PATH = join(process.env.HOME ?? "/root", ".openclaw", "onebot-app-config.json");
const DEFAULT_APP_CONFIG = Object.freeze({
    batchGapMs: 1500,
    batchMaxMessages: 12,
    batchMaxChars: 50000,
    defaultResponseTimeoutMs: 150000,
    imageAnalysisResponseTimeoutMs: 250000,
    imageResponseTimeoutMs: 600000,
    guestReplyIntervalMs: 60000,
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
        imageAnalysisResponseTimeoutMs: [1000, 3600000],
        imageResponseTimeoutMs: [1000, 3600000],
        guestReplyIntervalMs: [1000, 3600000],
    };
    for (const [key, [min, max]] of Object.entries(bounds)) {
        if (!Number.isSafeInteger(config[key]) || config[key] < min || config[key] > max)
            throw new Error(`Invalid OneBot app config: ${key} must be an integer between ${min} and ${max}`);
    }
    return Object.freeze(Object.fromEntries(Object.keys(bounds).map((key) => [key, config[key]])));
}

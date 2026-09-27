import { readFileSync } from "node:fs";
import { join } from "node:path";

export const APP_CONFIG_PATH = join(process.env.HOME ?? "/root", ".openclaw", "onebot-app-config.json");

export function loadAppConfig(path = APP_CONFIG_PATH) {
    const config = JSON.parse(readFileSync(path, "utf8"));
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

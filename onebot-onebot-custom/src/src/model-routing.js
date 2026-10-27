import { onebotPath } from "./paths.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const MODEL_ROUTING_PATH = onebotPath("onebot-model-routing.json");
const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function loadModelRouting(path = MODEL_ROUTING_PATH) {
    const config = JSON.parse(readFileSync(path, "utf8"));
    const presetName = String(config.activePreset ?? "");
    const preset = config.presets?.[presetName];
    if (!preset)
        throw new Error(`OneBot model routing preset not found: ${presetName || "(empty)"}`);
    const normalizeRoute = (route, label) => {
        const model = typeof route?.model === "string" ? route.model.trim() : "";
        const thinking = typeof route?.thinking === "string" ? route.thinking.trim() : "";
        if (!/^[^/\s]+\/[^/\s]+$/u.test(model))
            throw new Error(`Invalid ${label}.model in ${path}`);
        if (!VALID_THINKING_LEVELS.has(thinking))
            throw new Error(`Invalid ${label}.thinking in ${path}`);
        return { model, thinking };
    };
    const normalizeRoutes = (routes, label) => {
        if (!Array.isArray(routes) || routes.length === 0)
            throw new Error(`${label} must contain at least one model route`);
        return routes.map((route, index) => normalizeRoute(route, `${label}[${index}]`));
    };
    return {
        presetName,
        flashLiteFallbacks: normalizeRoutes(config.flashLiteFallbacks ?? [{model:"gemini-official/gemini-3.5-flash-lite",thinking:"off"}, ...preset.errorFallbacks], "flashLiteFallbacks"),
        conversation: normalizeRoute(preset.conversation, "conversation"),
        textReview: normalizeRoute(preset.textReview, "textReview"),
        contentFallbacks: normalizeRoutes(preset.contentFallbacks, "contentFallbacks"),
        errorFallbacks: normalizeRoutes(preset.errorFallbacks, "errorFallbacks"),
    };
}

import { onebotPath } from '../paths.js';
import { readFileSync } from 'node:fs';
import { BUSINESS_TOOLS } from './catalog.js';
export function executorSettings() {
    const config = JSON.parse(readFileSync(onebotPath('onebot-executors.json'), 'utf8'));
    if (config.version !== 1 || !config.tools || Object.keys(config).some(k => !['version', 'tools'].includes(k))) throw new Error('invalid executor settings');
    for (const [name, value] of Object.entries(config.tools)) {
        const specification = BUSINESS_TOOLS[name];
        if (!specification || typeof value.enabled !== 'boolean' || !Number.isInteger(value.timeoutMs) || value.timeoutMs < 1000 || value.timeoutMs > specification.timeoutMs
            || !Number.isInteger(value.maxConcurrent) || value.maxConcurrent < 1 || value.maxConcurrent > 4 || Object.keys(value).some(k => !['enabled', 'timeoutMs', 'maxConcurrent'].includes(k))) throw new Error(`invalid executor setting: ${name}`);
    }
    // Additive speech capability is enabled by default without breaking older settings.
    if (!config.tools.tts_synthesize) config.tools.tts_synthesize = { enabled: true, timeoutMs: BUSINESS_TOOLS.tts_synthesize.timeoutMs, maxConcurrent: 1 };
    for (const name of ['reminder_create', 'reminder_list', 'reminder_cancel'])
        if (!config.tools[name]) config.tools[name] = { enabled: true, timeoutMs: BUSINESS_TOOLS[name].timeoutMs, maxConcurrent: 2 };
    if (!config.tools.xhs_media_workflow) config.tools.xhs_media_workflow = {enabled:true,timeoutMs:180000,maxConcurrent:4};
    if (!config.tools.xhs_send_media) config.tools.xhs_send_media = {enabled:true,timeoutMs:180000,maxConcurrent:1};
    for (const [name,spec] of Object.entries(BUSINESS_TOOLS)) if(spec.xOperation && !config.tools[name]) config.tools[name]={enabled:true,timeoutMs:spec.timeoutMs,maxConcurrent:spec.maxConcurrent};
    for (const [name,spec] of Object.entries(BUSINESS_TOOLS)) if(spec.reachOperation && !config.tools[name]) config.tools[name]={enabled:true,timeoutMs:spec.timeoutMs,maxConcurrent:spec.maxConcurrent};
    for (const name of Object.keys(BUSINESS_TOOLS)) if (!config.tools[name]) throw new Error(`missing executor: ${name}`);
    return config.tools;
}

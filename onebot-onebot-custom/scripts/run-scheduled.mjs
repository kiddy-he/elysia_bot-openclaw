import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { loadFeatureConfig } from '../src/src/feature-policy.js';
import { onebotPath } from '../src/src/paths.js';
const [id, ...extra] = process.argv.slice(2);
try {
    if (extra.length || !/^[0-9a-f-]{36}$/u.test(id ?? '')) throw new Error('invalid service identity');
    const policy = loadFeatureConfig();
    const services = JSON.parse(readFileSync(onebotPath('onebot-services.json'), 'utf8'));
    const definition = services.jobs?.[id], binding = policy.automationBindings[id];
    if (services.version !== 1 || !definition || !binding?.enabled || binding.feature !== definition.feature || !policy.features[binding.feature].enabled
        || binding.deliveryGroupIds.some(groupId => !policy.groups[groupId]?.enabled || !policy.features[binding.feature].groupIds.includes(groupId))) throw new Error('service grant disabled or missing');
    if (!Array.isArray(definition.argv) || !definition.argv.length || definition.argv.some(value => typeof value !== 'string') || !definition.argv[0].startsWith('/')) throw new Error('invalid fixed service argv');
    const child = spawn(definition.argv[0], definition.argv.slice(1), { cwd: definition.cwd ?? '/root', shell: false, stdio: 'inherit',
        env: { ...process.env, ONEBOT_ORIGIN_JOB_ID: id, ONEBOT_IMAGE_HELPER_AGENT_ID: definition.helperAgentId ?? 'qq-auto-elysia-normal-helper' } });
    const forward = signal => { try { child.kill(signal); } catch {} };
    process.once('SIGTERM', () => forward('SIGTERM')); process.once('SIGINT', () => forward('SIGINT'));
    child.on('error', () => { console.error('{"status":"failed","reason":"fixed service launch failed"}'); process.exitCode = 1; });
    child.on('exit', (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
} catch (error) { console.error(JSON.stringify({ status: 'not_executed', reason: error.message })); process.exitCode = 1; }

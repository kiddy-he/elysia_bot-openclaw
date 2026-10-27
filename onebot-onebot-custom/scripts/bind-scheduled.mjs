import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { loadFeatureConfig, validateFeatureConfig } from '../src/src/feature-policy.js';
import { onebotPath } from '../src/src/paths.js';
const [action, id, date, enabled = "true", attempt] = process.argv.slice(2);
if (!['add-qzone', 'add-qzone-retry', 'add-qzone-patrol', 'remove'].includes(action) || !/^[0-9a-f-]{36}$/u.test(id ?? '')) throw new Error('invalid binding operation');
const policy = structuredClone(loadFeatureConfig());
const path = onebotPath('onebot-services.json');
const services = JSON.parse(readFileSync(path, 'utf8'));
if (action === 'add-qzone-patrol') {
    policy.automationBindings[id] = { feature: 'qzone', name: 'qzone-elysia-interaction-patrol', enabled: enabled === 'true', deliveryGroupIds: [] };
    services.jobs[id] = { kind: 'command', accountId: 'default', feature: 'qzone', argv: ['/opt/node-v25.9.0-linux-x64/bin/node', '/root/.openclaw/workspace/skills/qzone-ops/scripts/qzone-patrol.mjs', 'run'],
        cwd: '/root/.openclaw/state/qzone-patrol', helperAgentId: 'qq-auto-elysia-normal-helper' };
} else if (action === 'add-qzone' || action === 'add-qzone-retry') {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error('invalid date');
    const retry = action === 'add-qzone-retry';
    if (retry && !/^[2-6]$/u.test(attempt ?? '')) throw new Error('invalid bounded Qzone retry attempt');
    policy.automationBindings[id] = { feature: 'qzone', name: `qzone-elysia-${retry ? 'prepare-retry' : 'publish'}-${date}${retry ? `-${attempt}` : ''}`, enabled: enabled === 'true', deliveryGroupIds: [] };
    services.jobs[id] = { kind: 'command', accountId: 'default', feature: 'qzone', argv: ['/opt/node-v25.9.0-linux-x64/bin/node', '/root/.openclaw/workspace/skills/qzone-ops/scripts/qzone-daily.mjs', retry ? 'prepare-retry' : 'publish', date, ...(retry ? [attempt] : [])],
        cwd: '/root/.openclaw/state/qzone-daily', helperAgentId: 'qq-auto-elysia-normal-helper' };
} else {
    if (policy.automationBindings[id]?.feature !== 'qzone' || !/^qzone-elysia-(?:publish|prepare-retry)-/u.test(policy.automationBindings[id]?.name ?? '')) throw new Error('only ephemeral Qzone jobs can be removed');
    delete policy.automationBindings[id]; delete services.jobs[id];
}
validateFeatureConfig(policy);
for (const [destination, value] of [[path, services], [onebotPath('onebot-features.json'), policy]]) {
    const temporary = `${destination}.${process.pid}.tmp`; writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); renameSync(temporary, destination);
}
console.log(JSON.stringify({ ok: true, action, jobId: id }));

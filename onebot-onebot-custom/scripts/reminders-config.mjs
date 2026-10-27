import { readFile, mkdir, writeFile, copyFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { validateFeatureConfig } from '../src/src/feature-policy.js';
import { BUSINESS_TOOLS } from '../src/src/features/catalog.js';
const root = resolve(process.env.ONEBOT_CONFIG_ROOT || '/root/.openclaw');
const apply = process.argv.includes('--apply');
const policy = JSON.parse(await readFile(join(root, 'onebot-features.json'), 'utf8'));
policy.features.reminders ??= { name: '对话定时提醒', enabled: true, implemented: true,
    groupIds: [...policy.features.conversation.groupIds], accountIds: [...policy.features.conversation.accountIds],
    actions: Object.fromEntries(['create', 'list', 'cancel'].map(action => [action, { enabled: true, profile: 'public' }])) };
validateFeatureConfig(policy);
const executors = JSON.parse(await readFile(join(root, 'onebot-executors.json'), 'utf8'));
for (const name of ['reminder_create', 'reminder_list', 'reminder_cancel']) executors.tools[name] ??= { enabled: true, timeoutMs: BUSINESS_TOOLS[name].timeoutMs, maxConcurrent: 2 };
const entries = [['onebot-features.json', policy], ['onebot-executors.json', executors]];
const changed = [];
const backup = join(root, 'state/backups', `reminders-config-${Date.now()}`);
for (const [name, value] of entries) {
    const path = join(root, name), text = JSON.stringify(value, null, 2) + '\n';
    if (await readFile(path, 'utf8') === text) continue;
    changed.push(name);
    if (apply) {
        await mkdir(backup, { recursive: true, mode: 0o700 }); await copyFile(path, join(backup, name));
        const tmp = `${path}.${process.pid}.tmp`; await writeFile(tmp, text, { mode: 0o600 }); await rename(tmp, path);
    }
}
console.log(JSON.stringify({ applied: apply, changed, ...(apply && changed.length ? { backup } : {}) }));

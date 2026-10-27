import { onebotPath } from '../paths.js';
import { readFile, writeFile, rename, readdir, readlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { loadFeatureConfig, validateFeatureConfig } from '../feature-policy.js';
import { scopedAgent } from '../workspaces/routes.js';
import { loadServiceRegistry } from '../access/services.js';
import { syncBilibiliSubscription, bilibiliSubscriptionStatus } from './bilibili-sync.js';
const run = promisify(execFile);
const cli = async args => JSON.parse((await run('/usr/local/bin/openclaw', args, { timeout: 30000, maxBuffer: 1024 * 1024 })).stdout);

export async function rewardsControl(action) {
    if (!['start', 'stop', 'restart'].includes(action)) throw new Error('invalid Rewards control');
    const env = await readFile('/root/Microsoft-Rewards-Script/.env', 'utf8');
    const key = /^API_TOKEN=(.+)$/mu.exec(env)?.[1]?.trim();
    if (!key) throw new Error('Rewards credential unavailable');
    const response = await fetch(`http://127.0.0.1:3010/${action}`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Rewards API HTTP ${response.status}`);
    const result = await response.json();
    return { ok: result.ok !== false && result.success !== false, action, state: result.state, message: typeof result.message === 'string' ? result.message.slice(0, 300) : undefined };
}
export async function alasStop({ dryRun = false } = {}) {
    const root = '/root/AzurLaneAutoScript'; const pids = [];
    for (const pid of await readdir('/proc')) {
        if (!/^\d+$/u.test(pid)) continue;
        try {
            if (await readlink(`/proc/${pid}/cwd`) !== root) continue;
            const args = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
            if (!args.some(arg => arg === 'gui.py' || arg === `${root}/gui.py`)) continue;
            pids.push(Number(pid));
        } catch { /* process ended */ }
    }
    if (!dryRun) for (const pid of pids) { try { process.kill(pid, 'SIGINT'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    if (dryRun) return { ok: true, action: 'stop-plan', pids, verifiedStopped: false };
    for (let attempt = 0; attempt < 10; attempt++) {
        const remaining = pids.filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
        if (!remaining.length) return { ok: true, action: 'stop', verifiedStopped: true };
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return { ok: false, action: 'stop-requested', verifiedStopped: false, reason: 'processes did not stop before verification deadline' };
}
const configPath = onebotPath('onebot-features.json');
export async function bilibiliRoute(params) {
    return syncBilibiliSubscription(params);
}
export async function automationReminder(params, { runCli = cli, writeBinding = async (id, binding, subject) => {
    const config = structuredClone(loadFeatureConfig());
    if (binding) config.automationBindings[id] = binding; else delete config.automationBindings[id];
    validateFeatureConfig(config);
    const services = loadServiceRegistry();
    if (subject) services.jobs[id] = subject;
    if (!binding) delete services.jobs[id];
    const registryPath = onebotPath('onebot-services.json');
    await writeFile(`${registryPath}.${process.pid}.tmp`, JSON.stringify(services, null, 2) + '\n', { mode: 0o600 }); await rename(`${registryPath}.${process.pid}.tmp`, registryPath);
    const temp = `${configPath}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 }); await rename(temp, configPath);
} } = {}) {
    const { action, jobId, name, message, cron, groupId, accountId } = params;
    if (action === 'create') {
        if (!/^[\w-]{1,80}$/u.test(name) || !message || message.length > 4000 || !/^\d{1,2} \d{1,2} \* \* [0-7,*-]+$/u.test(cron)) throw new Error('only daily/weekly bounded reminders supported');
        const [minute, hour] = cron.split(' ').map(Number); if (minute > 59 || hour > 23) throw new Error('invalid schedule');
        const agent = scopedAgent({ scope: 'automation', conversationId: 'public', roleAgentId: accountId === 'yuexia' ? 'onebot-yuexia' : 'main', purpose: 'rewrite' });
        // Register a disabled job before granting it a service identity.
        const result = await runCli(['cron', 'add', '--name', name, '--cron', cron, '--tz', 'Asia/Shanghai', '--disabled', '--agent', agent,
            '--session', 'isolated', '--message', message, '--tools', accountId === 'default' ? 'tts_synthesize' : '', '--announce', '--channel', 'onebot', '--account', accountId, '--to', `group:${groupId}`, '--json']);
        const id = result.id ?? result.job?.id;
        if (!/^[0-9a-f-]{36}$/u.test(id ?? '')) throw new Error('cron creation returned no id; inspect before retry');
        await writeBinding(id, { feature: 'automation', name, enabled: true, deliveryGroupIds: [groupId] }, { kind: 'agent', feature: 'automation', accountId, agentId: agent, actions: [],
            ...(accountId === 'default' ? { speechTarget: { type: 'group', id: String(groupId) } } : {}) });
        await runCli(['gateway', 'call', 'cron.update', '--params', JSON.stringify({ id, patch: { payload: { kind: 'agentTurn', toolsAllow: accountId === 'default' ? ['tts_synthesize'] : [] } } }), '--json']);
        await runCli(['cron', 'enable', id]);
        return { ok: true, jobId: id, status: 'enabled' };
    }
    const binding = loadFeatureConfig().automationBindings[jobId];
    if (!binding) throw new Error('unknown registered job');
    if (action === 'enable' || action === 'disable') {
        if (action === 'disable') await runCli(['cron', 'disable', jobId]);
        await writeBinding(jobId, { ...binding, enabled: action === 'enable' });
        if (action === 'enable') await runCli(['cron', 'enable', jobId]);
        return { ok: true, jobId, status: action === 'enable' ? 'enabled' : 'disabled' };
    }
    if (action === 'edit') {
        if (binding.feature !== 'automation' || (!message && !cron)) throw new Error('only registered reminder payload/schedule edits supported');
        const args = ['cron', 'edit', jobId];
        if (message) args.push('--message', message);
        if (cron) {
            const [minute, hour] = cron.split(' ').map(Number);
            if (!/^\d{1,2} \d{1,2} \* \* [0-7,*-]+$/u.test(cron) || minute > 59 || hour > 23) throw new Error('invalid schedule');
            args.push('--cron', cron, '--tz', 'Asia/Shanghai');
        }
        await runCli(args);
        return { ok: true, jobId, status: 'updated' };
    }
    if (action === 'delete') { await runCli(['cron', 'rm', jobId]); await writeBinding(jobId, null); return { ok: true, jobId, status: 'deleted' }; }
    throw new Error('unsupported reminder operation');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    try {
        const [name, input] = process.argv.slice(2);
        const result = name === 'rewards' ? await rewardsControl(input) : name === 'alas-stop' ? await alasStop()
            : name === 'automation' ? await automationReminder(JSON.parse(input)) : name === 'bilibili-route' ? await bilibiliRoute(JSON.parse(input))
            : name === 'bilibili-status' ? await bilibiliSubscriptionStatus(JSON.parse(input)) : null;
        if (!result) throw new Error('unknown fixed command');
        console.log(JSON.stringify(result)); if (result.ok === false) process.exitCode = 1;
    } catch (error) { console.error(JSON.stringify({ ok: false, error: String(error.message).slice(0, 500) })); process.exitCode = 1; }
}

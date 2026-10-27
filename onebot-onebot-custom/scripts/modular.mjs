import { readFile, readdir, lstat, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onebotPath } from '../src/src/paths.js';
import { loadFeatureConfig } from '../src/src/feature-policy.js';
import { loadWorkspaceRoutes } from '../src/src/workspaces/routes.js';
import { executorSettings } from '../src/src/features/settings.js';
import { deliverySettings } from '../src/src/delivery/limiter.js';
import { loadServiceRegistry } from '../src/src/access/services.js';
import { validateBilibiliConfig } from '../src/src/features/bilibili.js';
import { BUSINESS_TOOLS } from '../src/src/features/catalog.js';
import { operationStore } from '../src/src/access/operations.js';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile), command = process.argv[2] ?? 'check';
if (command === 'check') {
    const policy = loadFeatureConfig(), routes = loadWorkspaceRoutes(), services = loadServiceRegistry();
    const executors = executorSettings(), delivery = deliverySettings();
    const bilibili = validateBilibiliConfig(JSON.parse(await readFile(onebotPath('onebot-bilibili.json'), 'utf8')));
    const core = JSON.parse(await readFile(onebotPath('openclaw.json'), 'utf8'));
    const validate = JSON.parse((await run('/usr/local/bin/openclaw', ['config', 'validate', '--json'], { timeout: 30000 })).stdout);
    if (!validate.valid) throw new Error('OpenClaw configuration rejected');
    const jobs = JSON.parse((await run('/usr/local/bin/openclaw', ['cron', 'list', '--all', '--json'], { timeout: 30000 })).stdout).jobs;
    const drift = [];
    for (const job of jobs) if (job.enabled && job.agentId?.startsWith('qq-') && !policy.automationBindings[job.id]) drift.push(`unregistered public task ${job.id}`);
    for (const [id, info] of Object.entries(routes.agents)) {
        const agent = core.agents.entries[id];
        if (!agent) { drift.push(`missing agent ${id}`); continue; }
        if (info.scope === 'private') continue;
        const expectedSkills = info.accountId === 'default' && (info.purpose === 'main' || info.scope === 'automation') ? ['elysia-tts'] : [];
        if (agent.workspace !== info.workspace || agent.memory?.search?.enabled !== false || JSON.stringify(agent.skills) !== JSON.stringify(expectedSkills)) drift.push(`workspace policy ${id}`);
        if (agent.heartbeat) drift.push(`unexpected public heartbeat ${id}`);
        for (const entry of await readdir(info.workspace, { withFileTypes: true })) if (entry.isSymbolicLink()) drift.push(`workspace symlink ${id}/${entry.name}`);
    }
    for (const [key, route] of Object.entries(routes.routes)) for (const id of Object.values(route)) if (!routes.agents[id] || !core.agents.entries[id]) drift.push(`unresolved route ${key}`);
    for (const [id, binding] of Object.entries(policy.automationBindings)) {
        const job = jobs.find(job => job.id === id), subject = services.jobs[id];
        if (!job || !subject || subject.feature !== binding.feature) { drift.push(`service contract ${id}`); continue; }
        if (!job.enabled) continue;
        if (subject.kind === 'agent' && (job.agentId !== subject.agentId || routes.agents[subject.agentId]?.scope !== 'automation')) drift.push(`private/mismatched scheduled agent ${id}`);
        const expectedTools = [...(subject.feature === 'rewards' ? ['rewards_summary'] : []), ...(subject.accountId === 'default' ? ['tts_synthesize'] : [])];
        if (subject.kind === 'agent' && JSON.stringify(job.payload?.toolsAllow) !== JSON.stringify(expectedTools)) drift.push(`scheduled tool cap ${id}`);
        if (subject.kind === 'command' && JSON.stringify(job.payload?.argv) !== JSON.stringify([process.execPath, `${project}/scripts/run-scheduled.mjs`, id])) drift.push(`unwrapped scheduled command ${id}`);
    }
    console.log(JSON.stringify({ valid: drift.length === 0, features: Object.keys(policy.features).length, dedicatedTools: Object.keys(BUSINESS_TOOLS).length,
        generatedAgents: Object.keys(core.agents.entries).filter(id => id.startsWith('qq-')).length, workspaceRoutes: Object.keys(routes.routes).length,
        registeredJobs: Object.keys(policy.automationBindings).length, bilibiliLiveEnabled: bilibili.enabled, drift }));
    if (drift.length) process.exitCode = 1;
} else if (command === 'status') {
    const store = operationStore();
    const summary = table => store.db.prepare(`SELECT state,COUNT(*) AS count FROM ${table} GROUP BY state ORDER BY state`).all();
    console.log(JSON.stringify({ operations: summary('operations'), deliveries: summary('deliveries'),
        artifacts: store.db.prepare('SELECT COUNT(*) AS count,SUM(bytes) AS bytes FROM artifacts').get(),
        pendingApprovals: store.db.prepare("SELECT COUNT(*) AS count FROM operations WHERE state='waiting_approval' AND created>?").get(Date.now() - 600000) }));
    store.close();
} else if (command === 'gc') {
    const store = operationStore(), settings = deliverySettings(), apply = process.argv.includes('--apply');
    const protectedPaths = new Set();
    let corruptRecords = 0;
    for (const row of store.db.prepare("SELECT request FROM deliveries WHERE state NOT IN ('accepted','suppressed','expired','denied','revoked')").all()) {
        try { for (const part of JSON.parse(row.request).parts) { if (part.path) protectedPaths.add(part.path); for (const node of part.nodes ?? []) { if (node.path) protectedPaths.add(node.path); for (const media of node.media ?? []) if (media.path) protectedPaths.add(media.path); } } }
        catch { corruptRecords++; }
    }
    if (corruptRecords) {
        console.log(JSON.stringify({ apply, blocked: true, corruptRecords, removedArtifacts: 0, reason: '无法确认损坏记录的附件引用，保留全部附件；先核对隔离记录。' }));
        store.close(); process.exit(apply ? 1 : 0);
    }
    const removed = [];
    for (const artifact of store.db.prepare('SELECT * FROM artifacts WHERE created<?').all(Date.now() - settings.artifactRetentionDays * 86400000)) {
        const managed = ['media/outbound/onebot', 'state/business/artifacts'].some(root => artifact.path.startsWith(onebotPath(root) + '/'));
        if (protectedPaths.has(artifact.path) || !managed || !/^[a-f0-9]{64}$/u.test(artifact.hash)) continue;
        if (apply) { const info = await lstat(artifact.path).catch(error => { if (error.code !== 'ENOENT') throw error; }); if (info?.isFile() && !info.isSymbolicLink()) await unlink(artifact.path); store.db.prepare('DELETE FROM artifacts WHERE hash=?').run(artifact.hash); }
        removed.push({ hash: artifact.hash, bytes: artifact.bytes });
    }
    console.log(JSON.stringify({ apply, eligibleArtifacts: removed.length, bytes: removed.reduce((sum, item) => sum + item.bytes, 0), uncertainArtifactsPreserved: protectedPaths.size }));
    store.close();
} else throw new Error('Use check|status|gc [--apply]');

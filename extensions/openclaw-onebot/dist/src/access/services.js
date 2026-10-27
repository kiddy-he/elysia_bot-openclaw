import { loadFeatureConfig, automationFeatureEnabled } from '../feature-policy.js';
import { loadWorkspaceRoutes } from '../workspaces/routes.js';
import { readFileSync } from 'node:fs';
import { onebotPath } from '../paths.js';
import { serviceSpeechPlan } from '../features/speech-policy.js';
export function loadServiceRegistry() {
    const value = JSON.parse(readFileSync(onebotPath('onebot-services.json'), 'utf8'));
    if (value.version !== 1 || !value.jobs) throw new Error('invalid service registry');
    return value;
}

export function qzonePreparationImageGrant(jobId, feature, action, accountId, policy = loadFeatureConfig(), registry = loadServiceRegistry()) {
    if (feature !== 'images' || action !== 'reference' || accountId !== 'default') return false;
    const binding = policy.automationBindings[jobId], subject = registry.jobs[jobId];
    if (!binding?.enabled || binding.feature !== 'qzone' || subject?.feature !== 'qzone' || subject.kind !== 'command' || subject.accountId !== 'default') return false;
    const argv = subject.argv;
    if (!Array.isArray(argv) || argv[0] !== '/opt/node-v25.9.0-linux-x64/bin/node'
        || argv[1] !== '/root/.openclaw/workspace/skills/qzone-ops/scripts/qzone-daily.mjs') return false;
    if (jobId === '4b13a241-07de-57bb-8d55-7c7fb958b5f3') return argv.length === 3 && argv[2] === 'prepare';
    return argv.length === 5 && argv[2] === 'prepare-retry' && /^\d{4}-\d{2}-\d{2}$/u.test(argv[3]) && /^[2-6]$/u.test(argv[4])
        && binding.name === `qzone-elysia-prepare-retry-${argv[3]}-${argv[4]}`;
}

export function trustedServiceContext(sessionKey, policy = loadFeatureConfig(), routes = loadWorkspaceRoutes()) {
    const match = /^agent:([^:]+):cron:([0-9a-f-]{36})(?::|$)/u.exec(String(sessionKey));
    if (!match) return null;
    const agent = routes.agents[match[1]], binding = policy.automationBindings[match[2]];
    const subject = loadServiceRegistry().jobs[match[2]];
    if (agent?.scope !== 'automation' || !binding?.enabled || subject?.kind !== 'agent' || subject.agentId !== match[1] || subject.accountId !== agent.accountId || subject.feature !== binding.feature) return null;
    const speech = serviceSpeechPlan(String(sessionKey));
    return { actorType: 'service', originJobId: match[2], accountId: agent.accountId, workspaceAgentId: match[1],
        ...(speech ? { speechMode: speech.explicit ? 'explicit' : 'ordinary' } : {}),
        ...(/:run:[^:]+/u.test(String(sessionKey)) ? { requestId: String(sessionKey) }
            : speech?.token ? { requestId: `${sessionKey}:speech:${speech.token}` } : {}) };
}
export function authorizeServiceTool(context, specification, policy = loadFeatureConfig()) {
    const binding = policy.automationBindings[context?.originJobId];
    if (specification.speech === true && specification.feature === 'conversation' && specification.action === 'media') {
        if (context?.accountId !== 'default') return false;
        if (context.speechMode === 'ordinary' && !context.speechAppendix) return false;
        const subject = loadServiceRegistry().jobs[context?.originJobId];
        return Boolean(binding?.enabled && policy.features[binding.feature]?.enabled && subject?.feature === binding.feature
            && subject.kind === 'agent' && subject.agentId === context.workspaceAgentId && subject.accountId === context.accountId
            && subject.speechTarget && automationFeatureEnabled(policy, 'conversation', 'media', context.accountId));
    }
    if (!binding?.enabled || binding.feature !== specification.feature || !automationFeatureEnabled(policy, specification.feature, specification.action, context.accountId)) return false;
    const subject = loadServiceRegistry().jobs[context.originJobId];
    if (!subject || subject.kind !== 'agent' || subject.agentId !== context.workspaceAgentId || subject.accountId !== context.accountId || !subject.actions?.includes(specification.action)) return false;
    // Agent cron jobs get only the concrete capabilities they currently need.
    return binding.feature === 'rewards' && specification.feature === 'rewards' && specification.action === 'read';
}

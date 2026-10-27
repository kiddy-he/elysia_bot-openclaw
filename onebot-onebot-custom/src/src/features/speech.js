import { loadFeatureConfig, authorizeFeature, automationFeatureEnabled, outboundTargetAllowed } from '../feature-policy.js';
import { loadServiceRegistry } from '../access/services.js';

/** A conversation may deliver only to the actual incoming event's peer. */
export function resolveConversationSpeechTarget(context, policy = loadFeatureConfig()) {
    const type = context?.scope, id = type === 'group' ? context.groupId : context?.senderId;
    if (context?.accountId !== 'default' || context.internal || !context.requestId
        || !['group', 'private'].includes(type) || !id
        || !authorizeFeature(policy, 'conversation', 'media', context).allowed
        || !outboundTargetAllowed(policy, context.accountId, type, id)) throw new Error('conversation speech destination denied');
    return { accountId: context.accountId, target: { type, id: String(id) }, feature: 'conversation', action: 'media' };
}

/** Destination is registered by trusted scheduling code, never model parameters. */
export function resolveSpeechTarget(context, policy = loadFeatureConfig(), registry = loadServiceRegistry()) {
    const jobId = context?.originJobId, binding = policy.automationBindings[jobId], subject = registry.jobs[jobId];
    const target = subject?.speechTarget;
    if (context.actorType !== 'service' || context.accountId !== 'default' || !binding?.enabled || !policy.features[binding.feature]?.enabled
        || subject?.kind !== 'agent' || subject.feature !== binding.feature || subject.accountId !== context.accountId
        || subject.agentId !== context.workspaceAgentId || !target || !['group', 'private'].includes(target.type)
        || !outboundTargetAllowed(policy, context.accountId, target.type, target.id)
        || !automationFeatureEnabled(policy, 'conversation', 'media', context.accountId)
        || (target.type === 'group' && (!binding.deliveryGroupIds.includes(String(target.id))
            || !policy.features.conversation.groupIds.includes(String(target.id))))
        || (target.type === 'private' && !policy.accounts[context.accountId].privateAdminIds.includes(String(target.id))))
        throw new Error('定时任务语音目标未登记或授权已撤销');
    const action = Object.keys(policy.features[binding.feature].actions).find(name => policy.features[binding.feature].actions[name].enabled);
    if (!action) throw new Error('任务功能已停用');
    return { accountId: context.accountId, target: { type: target.type, id: String(target.id) }, feature: binding.feature, action, originJobId: jobId };
}

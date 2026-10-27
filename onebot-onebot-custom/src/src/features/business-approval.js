// Only the dedicated catalog may reach this rule, after permission, schema and
// media ownership validation. Do not parse shell display strings for authority.
const script = '/root/.openclaw/workspace/skills/agy-proxy/scripts/agy-proxy-diagnose.sh';
const imageCommands = {
    onebot_image_generate: new Map([['image-generate', 3]]),
    image_edit: new Map([['image-edit', 4]]),
    image_reference: new Map([['official-image-generate', 4], ['official-image-generate-multi', 4]]),
};
export function trustedBusinessImageApproval(name, command) {
    const argv = command?.argv;
    if (command?.file !== '/bin/bash' || !Array.isArray(argv) || argv[0] !== script
        || !imageCommands[name]?.has(argv[1]) || imageCommands[name].get(argv[1]) !== argv.length
        || argv.some(value => typeof value !== 'string' || !value.length || value.includes('\0')))
        return undefined;
    return { decision: 'allow', trustedAllowlist: true,
        purpose: '通过已授权的专用图片工具执行固定生图或编辑流程。',
        rationale: '可执行文件、脚本、子命令和参数数量均匹配受信业务合同；文本按独立参数传入，不交给 shell 解析。' };
}

// The outer deadline must still settle even if a reviewer ignores cancellation.
// Effects belong to the caller and must check signal/state after this returns.
export async function boundedBusinessReview(review, { signal, timeoutMs = 90000 } = {}) {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(Object.assign(new Error('自动审查超时，尚未执行'), { code: 'review_expired' })), timeoutMs);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let onAbort;
    try {
        return await Promise.race([
            Promise.resolve().then(() => { combined.throwIfAborted(); return review(combined); }),
            new Promise((_, reject) => { onAbort = () => reject(combined.reason); combined.addEventListener('abort', onAbort, { once: true }); }),
        ]);
    } finally { clearTimeout(timer); combined.removeEventListener('abort', onAbort); }
}

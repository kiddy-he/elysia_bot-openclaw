import { createProgressToken, closeProgressToken, currentProgressToken } from './progress-state.js';
import { trustedFeatureContext, decideFeatureTool } from './feature-tools.js';
import { loadFeatureConfig } from './feature-policy.js';
import { BUSINESS_TOOLS } from './features/catalog.js';

// Only gateway-owned labels and terminal states may leave this tracker. Never
// forward commands, arguments, stdout, reasoning, paths, or error bodies.
const labels = Object.freeze({
    adsb_query: '查询飞机数据', alas_status: '检查任务状态', alas_screenshot: '获取截图',
    rewards_summary: '查询积分', rewards_control: '处理积分任务', downloads_query: '查询下载任务',
    downloads_control: '处理下载任务', qzone_read: '读取空间动态', qzone_publish: '处理空间发布',
    qzone_interact: '处理空间互动', quota_query: '查询额度', quota_refresh: '刷新额度',
    network_status: '检查网络状态', network_control: '处理网络操作',
    bilibili_status: '查询订阅状态', bilibili_subscribe: '配置订阅', automation_query: '查询自动任务',
    automation_manage: '配置自动任务', alas_control: '处理任务操作',
    x_media_workflow: '搜索并发送X完整媒体', x_search_posts: '搜索X帖子', x_inspect_posts: '核对X帖子',
    xhs_media_workflow: '搜索并发送小红书完整媒体', xhs_search_posts: '搜索小红书', xhs_inspect_posts: '核对小红书帖子', xhs_get_profile: '查看博主资料',
    xhs_read_comments: '读取小红书评论', xhs_list_images: '获取帖子图片列表', xhs_download_images: '创建图片下载任务',
    xhs_download_video: '创建视频下载任务', xhs_job_status: '核对下载进度', xhs_cancel_job: '取消下载任务', xhs_read_artifact: '准备合并媒体', xhs_send_media: '发送小红书合并消息',
    exec: '执行脚本步骤', process: '检查执行进度', read: '读取本次所需资料',
    write: '写入任务文件', edit: '修改任务文件', web_search: '检索资料', web_fetch: '读取网页',
});
const listeners = new Map();

export function toolProgressState(event) {
    const result = event.result;
    let detail = result?.details;
    if (!detail && BUSINESS_TOOLS[event.toolName] && Array.isArray(result?.content)) {
        // Dedicated executors may be normalized by the host to text content.
        try { detail = JSON.parse(result.content.find(item => item.type === 'text')?.text ?? 'null'); } catch {}
    }
    if (event.toolName === 'x_media_workflow' && detail?.x) {
        const data=detail.x.data;
        if(data?.delivery_status==='delivered' && data.receipt) return 'completed';
        if(['uncertain','native_pending','dispatching','ready'].includes(data?.delivery_status)) return 'uncertain';
        return 'failed';
    }
    if (event.toolName?.startsWith('xhs_') && detail?.xhs) {
        const xhs=detail.xhs, data=xhs.data;
        if (!xhs.ok || ['failed','cancelled'].includes(data?.state)) return 'failed';
        if (event.toolName === 'xhs_read_artifact' && data?.delivery_status === 'staged_for_forward') return 'running';
        if (['xhs_read_artifact','xhs_send_media','xhs_media_workflow'].includes(event.toolName)) return data?.delivery_status === 'delivered' && data?.receipt ? 'completed' : ['revoked','expired','failed_corrupt','denied'].includes(data?.delivery_status) ? 'failed' : 'uncertain';
        if (['queued','running'].includes(data?.state)) return 'running';
        if (data?.state === 'partial') return 'unconfirmed';
    }
    if (detail?.status === 'uncertain') return 'uncertain';
    if (detail?.status === 'running' || detail?.status === 'pending' || detail?.status === 'waiting_approval') return 'running';
    if (event.error || result?.isError || ['failed', 'not_executed', 'denied', 'error'].includes(detail?.status)
        || (typeof detail?.exitCode === 'number' && detail.exitCode !== 0)) return 'failed';
    if (detail?.status === 'succeeded' || detail?.status === 'completed' || detail?.exitCode === 0) return 'completed';
    // A returned generic tool payload is not proof of business completion.
    return 'unconfirmed';
}

export function bindTaskProgress(sessionKey, context, progress) {
    const token = { context, progress };
    const entries = listeners.get(sessionKey) ?? new Set(); entries.add(token); listeners.set(sessionKey, entries);
    return () => { entries.delete(token); if (!entries.size) listeners.delete(sessionKey); };
}

export function registerTaskProgressHooks(api) {
    const dispatch = (event, ctx, after) => {
        const entries = listeners.get(ctx.sessionKey);
        const trusted = trustedFeatureContext(ctx.sessionKey);
        if (entries?.size !== 1 || !trusted) return;
        const { context, progress } = [...entries][0];
        if (String(trusted.requestId) !== String(context.requestId) || trusted.senderId !== context.senderId
            || trusted.accountId !== context.accountId || (ctx.requester?.senderId != null && String(ctx.requester.senderId) !== String(context.senderId))
            || (ctx.requester?.accountId != null && String(ctx.requester.accountId) !== String(context.accountId))) return;
        if (!after && !decideFeatureTool(loadFeatureConfig(), event.toolName, event.params, trusted).allowed) return;
        const callId = event.toolCallId ?? ctx.toolCallId;
        // A late result from an older run must not be attributed to a new turn.
        if (!callId || (after && !progress.hasStep(callId, event.toolName))) return;
        progress.record(callId, event.toolName, after ? toolProgressState(event) : 'running');
    };
    api.on('before_tool_call', (event, ctx) => dispatch(event, ctx, false), { priority: -1000 });
    api.on('after_tool_call', (event, ctx) => dispatch(event, ctx, true));
}

export function createTaskProgress({ softMs, hardMs, send, isCurrent = () => true, onError = () => {}, context }) {
    if (!Number.isSafeInteger(softMs) || !Number.isSafeInteger(hardMs) || softMs <= 0 || hardMs <= softMs) throw new Error('invalid staged task deadline');
    const token = createProgressToken(context);
    const steps = new Map();
    let extended = false, closed = false, pending = Promise.resolve();
    const start = Date.now();
    const summary = () => {
        const groups = { completed: [], failed: [], uncertain: [], running: [], unconfirmed: [] };
        for (const item of steps.values()) groups[item.state]?.push(item.label);
        const line = (state, title) => groups[state].length ? `${title}：${[...new Set(groups[state])].join('、')}。` : '';
        return [line('completed', '已确认完成的步骤') || '目前还没有可确认完成的步骤。',
            line('failed', '未成功的步骤'), line('uncertain', '结果尚不确定的步骤'),
            line('running', '仍在等待的步骤'), line('unconfirmed', '已返回但尚需核实的步骤')].filter(Boolean).join('\n');
    };
    const softTimer = setInterval(() => {
        if (closed || !currentProgressToken(token) || !isCurrent()) return;
        // Skip a near-simultaneous progress update at the final deadline.
        if (Date.now() - start >= hardMs) return;
        extended = true;
        pending = pending.then(async () => {
            if (closed || !currentProgressToken(token) || !isCurrent()) return;
            await send(`阶段进展：\n${summary()}\n整体任务尚未完成，我会继续处理；本轮总等待上限为 ${Math.ceil(hardMs / 60000)} 分钟。`, {progressToken:token});
        }).catch(onError);
    }, softMs);
    let hardTimer;
    const deadline = new Promise((_, reject) => {
        hardTimer = setTimeout(() => {
            clearInterval(softTimer);
            const error = new Error('Extended response timeout'); error.code = 'TASK_DEADLINE'; reject(error);
        }, hardMs);
    });
    // The caller may still be constructing the dispatch before it races this.
    deadline.catch(() => {});
    return {
        deadline, token,
        get extended() { return extended; },
        hasStep(id, tool) { return steps.get(id)?.label === labels[tool]; },
        record(id, tool, state) {
            if (closed || !labels[tool]) return;
            const key = id || `${tool}:unidentified`;
            if (!steps.has(key) && steps.size >= 40) return;
            steps.set(key, { label: labels[tool], state });
        },
        async finish() { closed = true; closeProgressToken(token); clearInterval(softTimer); clearTimeout(hardTimer); await pending; },
        cancel() { closed = true; closeProgressToken(token); clearInterval(softTimer); clearTimeout(hardTimer); },
        finalText(text) { return extended ? `本次处理汇总：\n${summary()}\n\n${text}` : text; },
        timeoutText() { return `本次处理已达到 ${Math.ceil(hardMs / 60000)} 分钟总等待上限。\n${summary()}\n整体结果尚未确认完成，已停止本轮继续等待。已经开始的外部操作可能仍在处理，不会自动重复执行。`; },
    };
}

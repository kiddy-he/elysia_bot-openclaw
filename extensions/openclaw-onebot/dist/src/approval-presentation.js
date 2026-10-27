// Group approval cards must never echo command arguments, model prose, paths,
// URLs or upstream errors. Summaries are local fixed descriptions, not LLM text.
const summaries = {
    onebot_image_generate: '根据本次要求生成图片并保存结果。',
    image_edit: '按本次要求编辑已授权的图片并保存结果。',
    image_reference: '获取角色参考图，并据此生成图片。',
    quota_query: '查询模型账户的剩余额度。',
    quota_refresh: '刷新模型账户的额度信息。',
    qzone_publish: '发布本次指定的空间动态，或删除指定动态。',
    qzone_interact: '对本次指定的空间动态或评论执行互动。',
    network_control: '修改代理服务的运行状态，可能影响网络连接。',
    alas_control: '调整已指定的自动化服务运行状态。',
    automation_manage: '创建、修改或取消已指定的定时任务。',
    rewards_control: '调整积分任务服务的运行状态。',
    downloads_control: '对已指定的下载任务执行管理操作。',
};
export function groupApprovalDetails({toolName,command} = {}) {
    let summary = summaries[toolName];
    const source = String(command ?? '');
    if (!summary) {
        if (/\bagy-proxy-diagnose\.sh\b[\s\S]*\b(?:image-generate|image-edit|official-image-generate)/u.test(source)) summary='执行本次要求的图片生成或编辑流程。';
        else if (/\bsystemctl\b[\s\S]*\b(?:restart|stop|start|reload)\b/u.test(source)) summary='调整已指定服务的运行状态，可能影响服务可用性。';
        else if (/\b(?:journalctl|systemctl)\b/u.test(source)) summary='查询已指定服务的运行状态或日志。';
        else if (/qzone-cli\.mjs/u.test(source)) summary='执行本次指定的空间业务操作。';
        else if (/agy-proxy-diagnose\.sh/u.test(source)) summary='执行本次指定的模型服务查询或维护操作。';
        else summary='执行本次请求对应的后台操作。';
    }
    return [`操作说明：${summary}`,'','审查结论：需要管理员确认，当前尚未执行。','',
        '说明：本消息仅展示操作摘要；确认授权仅适用于本次操作及其原始参数。',''];
}

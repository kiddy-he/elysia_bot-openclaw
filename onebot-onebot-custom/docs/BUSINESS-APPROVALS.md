# 业务审批边界与显示（2026-10-22）

专用生图工具在 `prepare()` 完成身份、功能权限、参数 schema、入站媒体归属校验后，以 file/argv 结构匹配可信合同。仅 `/bin/bash`、固定 AGY 脚本、相应子命令及精确参数个数可以命中；本轮的批准仍绑定 operation fingerprint，执行一次即消费。普通 exec 和其他脚本不适用此规则。提示词始终作为独立参数经 execFile(shell:false) 传递，不能因为引号或 shell 样式文字触发主机命令。

一般业务模型审查不在宿主 15 秒 before_tool_call 中等待。钩子登记唯一 reviewing 操作并立即返回等待状态，后台审查最多 90 秒。有效 allow 且不是强制人工审批的工具才续执行并向原会话回报；网络和服务等原有人工审批保持不变。审查完成会重新核对原身份、参数、当前权限及操作状态。

截止或取消后不会执行和投递审批；AbortSignal 关闭审查 HTTP 请求及 Gemini curl 子进程，并阻止重试/回退。即使上游忽略取消，迟到结果也不能改操作状态。会话重置、会话取消和账号通道停止取消在途审查。进程重启后遗留 reviewing 会被终止，不自动恢复写操作。审批消息投递失败不发第二条，不自动执行；结果回传失败也不重复业务操作。

群聊审批卡只展示本地固定类别说明、需确认状态及引用确认/取消方式。不展示执行命令、参数、路径、URL、模型原文 purpose/rationale/voteRationales 或原始错误。这一显示边界与实际审批参数绑定相互独立。管理员私聊保留原有详情展示。

Grok 审查和其他 grok provider 调用统一读取 openclaw.json 的 provider 及文件型 secret 引用。当前 endpoint 为 https://provider.example.invalid/v1，模型 grok-4.7；密钥保存在权限 0600 的专用 secret 文件，不写入本说明。2026-10-22 已用最小只读命令做真实审查调用，单次返回有效 allow。

回归测试：business-approval.test.mjs、approval-presentation.test.mjs、approval-review-client.test.mjs，并执行全量插件测试。生图执行测试使用替身执行器验证授权和参数，不消耗真实图片额度。

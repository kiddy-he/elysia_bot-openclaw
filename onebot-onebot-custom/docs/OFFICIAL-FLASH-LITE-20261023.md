# Gemini Flash Lite 官方备用链验收（2026-10-23）

所有现有 Flash Lite 调用统一使用：原 AGY Lite → gemini-official/gemini-3.5-flash-lite → novacode/qwen3.8-flash-next → grok/grok-4.7。主模型不是 Lite 时保持原路由。现有图像复核的 High 优先级保持不变，其 Lite 分支进入该备用链。

覆盖入站消息语义分类、普通回复人设审查、命令自动安全审查的 Gemini Lite 分支、guest TTS 文本审查、X/XHS 媒体总结独立审查、生成图片质量复核及 QQ 空间发布时间一致性复核。text-fallback agent 的显式 Lite 主模型也已配置相同备用顺序。

公共实现位于 src/src/flash-lite-fallback.js；Python/Bash 通过 scripts/flash-lite-request.mjs 复用。官方端点采用 Google OpenAI 兼容 API，走本机既有出口代理 127.0.0.1:7890。密钥使用独立 0600 文件与 SecretRef，不复制到文档和运行日志；curl 请求的认证头通过文件描述符读取，不把密钥展开进进程参数。Qwen 不支持的 reasoning_effort 会被移除，Grok 使用允许的思考级别。

只有请求失败、响应不完整或无法通过结构校验时才切换模型。有效的拒绝、负面质量评分和 none 意图均作为最终结果，不能通过继续切换模型寻找放行。分类仍完全由 LLM 完成，没有恢复关键词意图路由。图片及时间证据在备用循环内复用原 Python 校验器，负面结论与无效响应分别处理。

额度正文仍由 LLM 完整生成，程序仅验证，不追加或拼接事实。修复了结尾自然提及“周配额”等泛指说明导致事实校验失败的问题；金额、百分比、模型、重置时间和窗口绑定继续严格检查，附加错误事实仍拒绝。

验证记录：

- OpenClaw 配置校验通过。
- 全量 339 项测试通过；125 个源码运行文件完成检查和部署。
- 原消息“检查一下agy的每周额度还剩多少”真实分类为 query。
- 注入 AGY 503 后，官方 Lite 在约 1.45 秒完成相同消息分类；Qwen 位于官方之后。
- 官方文本请求约 1.24 秒返回有效 JSON；原生图像桥接用本地纯红测试图返回 color=red。
- 真实取数、完整角色回复、admin 私聊与群聊本地捕获、guest TTS 文本审核合计约 38.65 秒；完整回复生成约 32.20 秒。
- 测试捕获端的两条 QQ 请求均未发送至真实群聊或私聊。另按用户明确授权向 admin 发送一次完成通知，回执单独记录。
- 最终服务 PID 697167，default 与 yuexia 均于北京时间 18:11:47 完成 Gateway ready。
- 北京时间 18:12:05 已向 admin 700000003 发送完成通知，OneBot 消息回执 -50462987。

验收明细见 OFFICIAL-FLASH-LITE-ACCEPTANCE-20261023.json。变更前配置、脚本和运行产物已保留备份。

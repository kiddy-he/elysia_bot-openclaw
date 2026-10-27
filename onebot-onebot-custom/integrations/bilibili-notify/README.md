# Bilibili 接入

接收器和路由工具已实现。2026-10-16 按用户授权启动本机容器并完成扫码登录，现已接入群 `700000012`：由爱莉账号发送 UID `700000010`、`700000001` 的动态与开播通知。两条订阅已启用并确认关注成功；动态检测已启动，两个直播间 WebSocket 已连接。实际链路测试已收到 QQ 消息回执，证据位于 `/root/.openclaw/state/bilibili-group-700000012/`。

本群仅 @ 爱莉触发对话，使用独立群聊工作区。每个 UP 的动态、开播分别使用独立 webhook connection 和其托管 endpoint，并绑定到固定群号；不启用 @ 全体、下播通知、打赏通知或定时锐评。上游 AI 当前关闭。动态通知仍使用原模板；2026-10-19 起，开播图片保留原模板，OpenClaw 根据主播名称、直播标题和分区生成爱莉希雅语气的群内邀约文案，再附上可信直播间链接，与图片合并为一条 QQ 消息投递。

上游使用 Akokk0/bilibili-notify 的 generic webhook。OpenClaw 接收地址为
`http://127.0.0.1:18789/onebot/bilibili/events`。支持上游原生 ISO 时间、文本、图片和 composite 混合消息；图片必须内联，不从第三方提供的 URL 抓取文件。

新增群聊或 UP 时的接入步骤：

1. 复用此部署目录的现有服务；首次部署时准备随机面板密码，使用 `deferred-live` profile 启动。主机网络模式下将面板限制在 `127.0.0.1:8787`，无需改变 OpenClaw 的监听地址。通过 SSH 转发访问面板；勿重新生成已有加密密钥。
2. 确认 B 站登录有效。为每个 UP／事件路由建立独立 generic webhook connection；上游每条 connection 自动派生一个托管 endpoint，使用它的 UUID 作为目标别名，不把外部正文当作群号。通过 `/api/subs` 配置订阅，检查 `followed`，再启用动态和开播路由。
3. generic webhook 配置上述地址；secret 使用 `/root/.openclaw/secrets/onebot-bilibili.key` 的值，勿写入群聊。上游原生头名是 `x-bilibili-notify-secret`。
4. 在 `onebot-bilibili.json.routes` 登记 `{targetId,uid,event,accountId,groupId,enabled}`，其中 `targetId` 必须等于上游 endpoint 的 ID；`event` 为 dynamic/live/all。必须仍在 `onebot-features.json` 的账号和群权限范围内。
5. 开启主权限文件中的 bilibili 模块以及接入配置中的 enabled。`bilibili_subscribe` 现会同步上游连接、托管目标、关注和订阅路由，再回读校验；仅回读成功才报告订阅已配置，真实通知投递须另看事件和回执。管理员可在群内单独 @ 爱莉说“监听 UID 700000010 的动态和开播”“取消 UID 700000010 的动态监听”“查看本群 B 站订阅”。群号由可信会话绑定，无需提供 targetId，也无需审批或再次确认；普通成员仍无订阅管理权限。
6. 测试指定 UP 的动态、开播、重连去重和目标群变更；在业务操作、原生投递、平台回执三处核对同一 operationId/deliveryId。

有动态 URL 或上游 eventId 时按稳定事件 ID 去重。开播元数据存在开播时间时，按目标路由、UID、房间号和开播时间去重，防止卡片数字刷新产生重复推送，也不会跨群吞通知。上游仅发送图片且没有事件 ID 时采用有界重复内容窗口：直播 1 小时，其余 24 小时；不同图片内容不能被可靠判定为同一事件。

## 开播图文合并

`onebot-bilibili.json` 中的 `liveNotifications: { "enabled": true }` 启用开播文案生成。专用 prompt 位于 `src/src/features/bilibili-live-notice.js`；仅把公开的主播名称、直播标题、分区发给无状态文本接口，不加载群聊历史、私聊、工作区记忆或工具。优先 `antigravity/gemini-3.8-flash-high`，失败再用 `novacode/qwen3.8-flash-next`，每次 API 请求最多 45 秒。缺失字段不编造；面向“大家／有空的朋友”，不使用“舰长”等身份称呼，不艾特个人或全体。链接由程序固定生成，不采纳模型返回的链接。

图片仍由上游原有 `generateLiveCard` 渲染。补丁仅让开播事件携带 `live: {kind,uid,roomId,upName,title,areaName,startedAt}`，并以一份 composite 传送原图与旧模板。接收器等文案完成后，替换旧文字，持久化最终图片和文案，通过统一原生 outbox 作为一个 captioned image 发送，最终对应一次 OneBot API 调用和一条平台回执。并发事件共享生成任务；生成完成后的队列重试复用已保存文案。权限在实际发送前重新校验。两路模型均失败时使用基于相同公开事实的简短邀约；上游图片渲染失败时降级为纯文字。

上游 generic 开播 webhook 的等待上限单独提升至 180 秒，其他 webhook 保持原超时。上游补丁脚本为 `patch-live-notify.mjs`，生成文件位于忽略版本控制的 `runtime/` 并只读挂载到 `/app/index.mjs`。首次部署或升级镜像前，应从对应镜像提取**未修改**的 `/app/index.mjs`，执行：

```sh
node patch-live-notify.mjs /path/to/original-index.mjs runtime/index.mjs
node --check runtime/index.mjs
docker compose --profile deferred-live up -d
```

补丁锚点与预期不符时拒绝生成，避免升级后静默失效。停用个性化文案只需关闭 `liveNotifications.enabled`；如需完整恢复上游原版，移除该文件挂载并重建容器。

所有通知经过统一业务记录和 OpenClaw 原生投递。关闭模块、撤销群或路由后，积压项在发送前再次校验。不启用上游的另一个 QQ 直发通道。

订阅同步由 `src/src/features/bilibili-sync.js` 完成，只请求固定的本机面板，凭据从私有 `.env` 加载，不接受模型传入 URL、Cookie、密码或目标群覆写。同一 UP 复用一条上游订阅，不同群和事件使用各自独立 endpoint。取消时先撤销本群投递，再移除该群相应的上游 routing；其他群、其他事件及上游自定义配置保留，不自动取关 UP。最后一条路由取消后停用空订阅，保留端点身份供重复请求和再次订阅复用。

同步状态记录在 `state/business/bilibili-sync/`。添加失败时新路由保持关闭；取消遇到上游故障时本群投递仍保持关闭，返回未同步完成，可重试相同请求进行收敛。全局跨进程锁防止多个群同时覆盖同一 UP 的路由；若执行进程意外被强制终止留下锁，应先核对上游、记录和进程状态再恢复，不根据锁文件年龄猜测并抢占。无需审批不代表放开身份、群范围或通用后台工具权限。

群聊执行入口须将 `bilibili` 计入可委派的专用业务工具，不能依赖 `system.tools` 或其他后台模块是否开放。群 700000012 只开放对话与 B 站订阅时，admin 单独 @ 仍应获得 B 站工具，不应收到“重新单独 @”的错误提示。艾特按消息段中的 QQ 账号识别，与群名片（例如“监控”）无关。模拟验收包含此最小权限群，以及同一条消息给出两个 UID 时逐个顺序同步。

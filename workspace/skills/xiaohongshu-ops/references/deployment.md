# 本机部署和验收记录

本文件是 2026-10-21 的本地快照，不是实时健康检查。

## 位置与前提

- 项目：`/root/komachi-xhs-js`。
- Skill 可审查源：项目 `skills/xiaohongshu-ops/`。
- 安装位置：`/root/.openclaw/workspace/skills/xiaohongshu-ops/`，属于默认 workspace。
- 插件源：项目 `openclaw-plugin/`；目前不是独立发布包，入口相对导入 `../src/`，不能只拷贝该子目录并假定依赖仍可找到。
- 业务会话目录：`/root/komachi-xhs-js/data/xhs-public`；仅由可信服务读取，不在对话或文档中导出认证文件内容。
- Node 要求来自项目 engines：`>=24.15.0`；sharp 为依赖，视频验收还需 ffprobe/ffmpeg。业务 HTTP 请求直连小红书，不使用本机代理。

2026-10-21 已将业务代码迁入 `/root/.openclaw/onebot-onebot-custom/src/src/xhs/`，由 `openclaw-onebot` 统一注册 11 个 `xhs_*` 工具和后台下载服务，无需启用独立 `komachi-xhs` 插件。复用当前已有登录账号，配置为 `/root/.openclaw/onebot-xhs.json`。权限由 onebot-features.json 的 xiaohongshu.read/media 和 admin-private profile 共同控制：所有用户的已接入私聊/群聊，全部群聊和 guest 私聊拒绝。

当前 `xhs_read_artifact` 只暂存；选全本轮图片及视频后调用 `xhs_send_media` 一次，作为一条合并消息投递当前 admin 私聊（每文件最多 25MiB），文字回复单独发送。取得 QQ 实际回执才报告 delivered。不能另用路径、message 或 MEDIA 重发。每次原始请求单独计算搜索预算；后续轮次的任务、图片、游标、产物句柄通过持久 owner 映射恢复原请求，并核对账号、发起用户和会话归属。foreground、background 和发送前均复查权限。

如果工具不可见，报告前提未满足，由运维按当前 OpenClaw SDK 和渠道权限配置插件；不要在普通用户会话中自行启用插件、构造 operator 上下文或改用 exec 绕过工具不可见状态。

## Skill 检查

运维可使用：

```bash
openclaw skills info xiaohongshu-ops
openclaw skills list --json
```

OpenClaw 的 skill “eligible/ready” 表示说明文件可加载，不保证小红书账户有效、插件已启用或每个工具已授权。默认 workspace 以外的 agent 有独立 skill 可见性；需要跨 workspace 部署时单独决定安装范围。

当前安装版 OpenClaw 的 skill 路径和 watcher 约定见本机官方文档：`/opt/node-v25.9.0-linux-x64/lib/node_modules/openclaw/docs/tools/skills.md`。一般下次新会话会取得技能快照；watcher 启用时可在下一 agent 回合刷新。实际以 `skills info` 和本轮工具目录为准，不主动重启网关来验证 skill。

## 服务合同和部署边界

OneBot 工厂只从绑定到实际入站事件的可信上下文取得身份；模型不能传入账号、收件人、路径或 operator 权限。撤权会阻止排队下载和延迟发送。新 call 的 job_status 每次读取新状态，read_artifact 跨轮也不会重复发送同一产物。会话认证文件仅由服务读取，禁止导出。

skill 不使用原始 CLI 作为隐式降级。库和 operator CLI 使用方法位于 [完整调用参考](api-reference.md) 的运维部分，仅供具备宿主权限的运维操作。

## 登录验证

已部署公网验证基础入口 `https://login.example.invalid:39081`。需要运维先启动当次任务，生成带短期凭据的交互链接；静态基础地址不代表有可用登录任务。

现有登录脚本：`/root/komachi-xhs-js/deploy/xhs-login/login-public.sh`。浏览器只在操作员登录任务期间启动，业务默认 HTTP。不要因查询缺少工具而启动登录，也不要假定评论的 461 一定可由重新扫码解决。

## 已有样本验收

| 能力 | 2026-10-21 记录 |
|---|---|
| 关键词搜索、详情、图集、图片下载 | 有限样本成功 |
| tag 模式 | 复用关键词接口；未验证精确 topic-only 过滤 |
| 博主资料与发布笔记 | 有限样本成功；未提供规范化粉丝数 |
| 兼容视频下载 | 成功一次，MP4/H.264 校验，5161155 字节 |
| 评论读取 | 返回 HTTP 461 challenge_required，成功分页尚未验收 |
| OpenClaw 工具 | 注册合同测试通过；不代表运行网关已暴露 |

脱敏证据见 [live-validation.json](live-validation.json)。只有本次真实工具响应才能证明本次查询成功。

2026-10-21：XHS内容工具对所有用户及当前接入群聊开放；发送仅回当前会话。每帖节点为【帖子标题】加完整图集/视频，总结单独发送。并发工具调用会按FIFO排队，最多64个等待项；等待计入工具超时，取消或撤权不执行。资源不得跨用户或跨会话复用。登录/换号/凭据/配置维护不开放给普通用户；本工具集没有平台互动写接口。

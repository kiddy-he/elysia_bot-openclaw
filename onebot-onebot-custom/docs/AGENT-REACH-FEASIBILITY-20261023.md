# Agent-Reach 接入本机 OpenClaw / LLBot 可行性分析

调研日期：2026-10-23 UTC（本机 Asia/Shanghai 已到 2026-10-24）。

## 结论与调研范围

可接入，推荐定位为新增平台的只读内容后端。优先补 GitHub、V2EX、YouTube 元数据/字幕，以及 Bilibili 视频读取；保留现有 Gemini 原生搜索、X/XHS 媒体工作流和 bilibili-notify。

用户明确要求使用 subagent，本次由 agent_reach_research 调研官方源码，主 agent 核对本机业务工具与权限/投递架构。只进行了源码、元数据和现有配置结构检查；没有安装、运行 Agent-Reach 项目代码、登录网站、修改运行配置、重启服务或发送 QQ 消息。

固定调研版本：

- v1.6.0，源码 pyproject.toml 标记 Beta。
- commit：beabda7486e9a666360b18cdb5c0e759c2c4d20f。
- commit 时间：2026-10-23 14:44:09 +08:00。
- GitHub release 元数据发布时间：2026-10-23 14:45:50 +08:00。
- 临时源码快照：/tmp/agent-reach-research-20261023。
- 临时元数据：/tmp/agent-reach-release-20261023.json、/tmp/agent-reach-repo-20261023.json。

未固定的 raw/main 网页一度返回旧实现。最终以以上 git 快照及固定 commit 网页为准：浏览器并发是同站 2、全局 4，不是旧版的全局串行；普通动作默认预算 30 秒，不是旧实现的 180 秒。转写等动作可单独设置更长预算。

## 能提供什么

| 平台 | 1.6 实际注册动作 | 本机接入建议与边界 |
|---|---|---|
| GitHub | search / read | 优先；仓库、README、Issue/PR、返回的评论；公开 REST 后备，不必为公开内容授予私有仓库权限 |
| V2EX | hot / node / read / user | 优先；公开主题/回复读取，低侵入 |
| YouTube | search / read / subtitle / transcribe | 优先元数据和已有字幕；转写单列，需额外工具/配额及较长执行时间 |
| Bilibili | search / read / hot / subtitle | 补视频读取和字幕；不接管 UP 开播/动态订阅和推送 |
| Web | search / read | Exa 搜索、Jina 读取及 Exa 后备；仅补原生搜索/正文读取能力 |
| Reddit | search / read / subreddit | 第二阶段；账号/网络和评论完整度必须实测 |
| X/Twitter | search / profile / tweets / thread | experimental，只读备选；不替代已建搜索、下载、全帖媒体和合并发送 |
| 小红书 | search / read / comments | 只读备选；不替代 komachi、SMS 恢复、图集校验和投递队列 |
| 雪球 | quote / search / hot_posts / hot_stocks | 按需求启用；行情和登录社区分开验收 |
| LinkedIn / Boss | jobs/read；search/read | 求职需求出现后再启用；不涉及私信或投递 |
| 小宇宙 | transcribe | 后续；Groq Key 和转写费用/配额单独授权 |
| Facebook / Instagram | search/profile；search/profile/posts | experimental，低优先 |
| RSS / 抖音 | 当前未注册独立渠道 | 不能按旧宣传视为现成功能；1.6 移除了 RSS channel |

Agent-Reach 没有通用 download 动作、持久化媒体任务/产物合同、QQ 合并转发和每帖全图集保证。转写内部下载音频不等于提供用户媒体下载业务。raw 中偶有媒体 URL 也不能当作可直接发送的完整图集。

上游自己的 1.6 发布说明仅报告 28/40 动作通过真实验收，B 站字幕、部分 Reddit/LinkedIn 等未在发版机测通。因此“有动作声明”不等于“本机可用”，也不能声称可以读全量评论或所有字幕。

## 接口与本机适配

### 主接口是受控 CLI

命令为 agent-reach <channel> <action> [args]，输出单个 JSON：

```json
{
  "schema_version": 1,
  "ok": true,
  "channel": "github",
  "action": "read",
  "backend": "...",
  "items": [{"title": "...", "url": "...", "author": "...", "published_at": null, "text": "...", "raw": {}}],
  "meta": {"elapsed_ms": 0, "attempts": []},
  "error": null
}
```

1.6 已移除 MCP server entry。源码不存在受支持的 api/serve 命令或 HTTP server 实现；REACH_API_SUPERVISED 只是子进程行为钩子，不能据此宣称已有 HTTP API。首期用固定 argv CLI 执行器即可；未来高频任务如有必要，再自行封装本地 sidecar。

上游会安装/链接 agent-reach skill（真实副本位于 ~/.agents/skills/agent-reach，OpenClaw 链接位于 ~/.openclaw/skills/agent-reach），但 skill 不负责本机 QQ 身份、群白名单、当前收件人和投递审计。不能只装 skill 就对 QQ 开放任意 exec。

### 推荐链路

```text
QQ 消息
  → 当前入站 LLM 语义分类 / 业务工具选择
  → trustedFeatureContext + 身份/群权限
  → Reach 专用只读业务工具
  → 固定版本 CLI、固定 argv、独立总耗时上限
  → JSON / 来源完整度校验与脱敏
  → 当前聊天主模型结合当前会话及角色生成回复
  → 现有 DeliveryQueue / QQ 发送
```

搜索需求判断仍由 LLM 完成，不增加关键词/正则意图路由。Gemini 原生 web_search 保持原链路；Reach 只作为明确的平台内容工具或读取后备。

建议新增固定 schema：

- reach_search：platform 枚举、query、limit；只映射实际有 search 的平台，不伪造 V2EX search。
- reach_read：platform、URL/平台资源 ID；URL 与平台绑定校验。
- reach_video_subtitle：platform、视频 URL、语言；没有字幕必须明确失败，不能把轨道列表当正文。
- 如需 V2EX 热门/节点，提供独立枚举动作，而非无约束 action 字符串。
- reach_health：仅 admin 可见，返回脱敏渠道状态，不向群聊暴露路径、账号和内部依赖。

用户不能传命令、可执行路径、输出目录、任意后端、环境变量或收件人。底层执行器通过 execFile(argv) 而不是拼 shell，使用可信当前消息绑定身份与目标。

### 需修改的本机文件

- src/src/features/catalog.js：工具 schema 和描述。
- src/src/features/tools.js：业务执行、幂等操作记录、JSON/error 映射。
- 新增 features/reach-provider.js / reach.js（建议）：固定 CLI 适配、结果正规化。
- src/src/feature-policy.js：若增加 reach feature，须同步 FEATURE_ACTIONS 和校验。
- config/onebot-features.schema.json、onebot-features.json：独立身份/群权限。
- onebot-executors.json：执行路径、超时和并发。
- src/openclaw.plugin.json：同步工具合同。
- src/src/turn-intent.js：仅在确有入站短路工作流需求时扩展分类；一般只读工具可由主对话按 schema 选择，避免无必要膨胀分类字段。
- 交付复用 src/src/delivery/queue.js，不新增第二套 QQ 发消息实现。
- 增加本机适配版 skill，说明业务工具选择和错误处理；不让其安装、更新、登录指令在普通群消息下触发。

以上为方案，未对这些运行文件实施修改。

## 环境、登录和并发

本机只读检查：Python3.12、Node、Docker、ffmpeg、Chromium 已在 PATH；uv、agent-reach、yt-dlp、gh、mcporter、opencli 未在 PATH 发现。这仅说明入口未发现，不证明其他 venv 中绝对不存在。

Agent-Reach 需要 Python ≥3.10；官方支持 uv，并明确 PyPI 同名 agent-reach 包不是本项目。部署应使用官方 GitHub release 的固定版本及依赖锁定，避免 main/latest 漂移。

setup 会安装默认渠道、依赖和 skill，不是单纯注册一个插件。浏览器渠道还需 CloakBrowser/Chrome、OpenCLI extension/bridge。建议独立运行账户及持久目录；不要把 Gateway 所有环境变量和密钥继承给子进程。当前 root 环境不能成为网站内容的默认可见运行空间。

浏览器特点：

- 所有浏览器平台共用 Reach 专用 profile，不按 QQ 用户隔离。
- CDP 回环端口 9222；bridge 回环端口 19825。本次 ss 快照未见这两个监听，但实施前仍需重新检查。
- 支持同站 2、全局 4 并发；每级槽位等待可达 120 秒，排队会暂停内部 action clock。
- 因此 --timeout 30 不等于 30 秒墙钟耗时，外围必须有总 deadline、取消和子进程树回收。
- 搜索节流 10 秒；限流默认冷却 3600 秒，部分后端失败暂停 60/120 秒。
- 专用浏览器闲置 10 分钟自动关闭，冷启动和登录窗口都会影响时延。

建议公开 HTTP/CLI 读取与浏览器渠道分队列；单个平台受限时不要阻塞别的用户整个聊天流。重复读取可缓存，但缓存键应包含平台、规范化查询、账号授权范围和来源新鲜度，不跨用户缓存私有内容。短任务优先既有字幕，ASR 独立成较长后台任务并沿用现有阶段反馈机制。

现有 X 账号数据库、komachi 会话与 Reach 的浏览器登录不是同一格式。Reach 可按站从已连接 Browser Bridge 的浏览器只读复制登录，但不保证自动识别本机两个自建服务。需要明确导入适配或在 Reach 专用窗口人工登录，不能直接抢占现有 VNC/X browser profile。

## 权限和错误处理建议

| 功能 | 建议权限 |
|---|---|
| 已验收公开内容搜索、详情、字幕 | 先 admin 私聊灰度，再按独立 feature 配置开放 member/visitor 与指定群 |
| 使用登录账号取得的非公开/个人信息 | 默认仅 admin 私聊；不能因为工具名是 read 就当成公开内容 |
| 登录、导入会话、切账号、安装、更新、配置密钥、卸载 | admin 运维操作，不暴露给普通群模型 |
| ASR 转写 | 单独开关、配额和时长限制；默认不因“没字幕”自动消耗配额 |
| 后续媒体下载发送 | 各平台单独验收产物合同，继续走现有交付约束 |

NEED_LOGIN：向 admin 请求人工处理，当前用户只接收脱敏状态；并合并短时间重复登录通知。

PLATFORM_BLOCKED：停止该次自动化，人工处理官方验证，不能切换账号/后端绕过挑战。

RATE_LIMITED：尊重 retry_after、退避和本机调度；BUSY 单独排队/提示；TIMEOUT 与上游故障分开记录。

items.raw 和 error.message 不是可直接发送到群聊的安全正文。需要字段允许列表、URL/凭证/路径脱敏、正文长度限制。站外内容作为不可信资料，不当作工具调用或人设指令。

上游有 URL 约束、有限响应体、argv 执行、私密文件权限、站点级 Cookie 复制等措施，但不能把这些等同于本项目的完整 SSRF、系统凭据和 QQ 授权隔离。任意网页读取继续经过本机 URL/出口约束。

## 实施和验收顺序

1. 固定 1.6.0，在隔离运行目录/账户安装所需公开渠道；记录依赖版本、端口、磁盘和冷启动资源，禁用自动更新。
2. 注册最小只读工具，mock 验收参数、未知平台、内网 URL、错误 JSON、凭据过滤、取消、重复请求、身份和群权限。
3. admin 私聊真实验收 GitHub 仓库/Issue、V2EX 主题、YouTube 元数据/已有字幕；逐项记录网络、耗时、来源和内容完整度。
4. Bilibili 视频/字幕、Reddit 等按账号和上游状态逐项灰度；验证多人同时请求、排队计时、人工登录期间查询、超时后进程回收。
5. 通过后开放指定公开动作给普通用户/指定群。X/XHS 仅尝试读取后备，不改变当前媒体下载和 QQ 合并发送规则。
6. 如确实需要新增平台媒体工作流，另做下载域名允许列表、全图集合同、视频兼容、产物存储、任务/收件人绑定及回执验收。

完成标准是具体动作在本机真实成功且权限/超时可控，不是 setup 或 doctor 显示已安装。本次没有做安装后的渠道实测，因此不能给出本机成功率或承诺浏览器任务 60 秒完成。

## 固定版本官方依据

基址：
`https://github.com/Panniantong/Agent-Reach/blob/beabda7486e9a666360b18cdb5c0e759c2c4d20f/`

- README.md、CHANGELOG.md：版本、重构、移除 MCP/RSS、真实验收范围。
- pyproject.toml：Python、Beta、依赖、CLI entry。
- docs/install.md：uv 和 GitHub 来源、PyPI 同名包区别。
- agent_reach/channels/__init__.py：14 渠道注册。
- agent_reach/skill/references/capabilities.md：真实动作及内容边界。
- agent_reach/runtime/result.py：JSON、错误码、停止重试语义。
- agent_reach/runtime/cli.py：受支持入口和管理动作。
- agent_reach/runtime/browser_binding.py：同站 2、全局 4、等待和计时暂停。
- agent_reach/runtime/dispatch.py：默认 30 秒、节流和暂停策略。
- agent_reach/runtime/manage.py：skill 链接及安装副作用。
- agent_reach/runtime/browser.py、bridge.py：浏览器与回环端口。
- agent_reach/runtime/session_reuse.py、sessions.py：登录复用与会话。
- agent_reach/runtime/tools.py：上游工具和已测版本。

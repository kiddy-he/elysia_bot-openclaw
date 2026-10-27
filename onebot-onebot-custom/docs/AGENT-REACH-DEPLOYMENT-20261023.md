# Agent-Reach 业务工具接入记录

实施日期：2026-10-23 UTC（北京时间 2026-10-24）。

## 最终配置

保留原 X 搜索、详情、媒体下载和 QQ 合并发送工作流。旧 Komachi 小红书代码、会话数据和文档保留，旧业务执行器暂停，业务改用 Agent-Reach 的搜索、文字详情和评论。新方案目前不提供旧方案的图集/视频下载、博主查询或媒体合并发送；不能将只读成功解释为图片已发送。

版本：官方 Agent-Reach v1.6.0，固定 commit `beabda7486e9a666360b18cdb5c0e759c2c4d20f`。安装使用官方源码，不使用 PyPI 上的同名包。安装工具 uv 0.13.5，bili-cli 0.6.2、OpenCLI 1.8.7、CloakBrowser 0.6.3、yt-dlp 2026.8.19；不是全部依赖的锁文件，重建时需再次核对。

| 来源 | 注册工具 | 业务范围 |
| --- | --- | --- |
| GitHub | github_search, github_read | 公开仓库搜索、README、Issue/PR及可见评论 |
| V2EX | v2ex_hot, v2ex_node, v2ex_read, v2ex_user | 热门、节点主题、主题正文/返回回复、用户公开信息 |
| YouTube | youtube_search, youtube_read, youtube_subtitle | 视频搜索、元数据、已有人工/自动字幕；不自动ASR |
| Bilibili | bilibili_video_search, bilibili_video_read, bilibili_video_hot, bilibili_video_subtitle | 视频搜索、元数据、热门、字幕；与原开播/动态监控分开 |
| Reddit | reddit_search, reddit_read, reddit_subreddit | 搜索/读取固定使用public-web；subreddit使用OpenCLI |
| 小红书 | reach_xhs_search, reach_xhs_read, reach_xhs_comments | 搜索、文字详情、已加载评论；登录失效时报告NEED_LOGIN |

19个工具均为专用只读动作，不需要命令审批。两个QQ账号 default/yuexia 可用，普通用户/admin可用；群范围沿用现有授权的700000008、700000011、700000012。新工具不会让机器人进入未授权群。所有外部正文均视为不可信资料。由聊天主模型结合当前会话与角色生成最终回复，没有新增正则意图路由。

配置：`/root/.openclaw/onebot-reach.json`；权限：`onebot-features.json`；工具开关：`onebot-executors.json`；旧小红书配置：`onebot-xhs.json`。

## 隔离和超时

独立系统用户 `openclaw-reach`，HOME `/var/lib/openclaw-agent-reach`，官方源码 `/opt/openclaw-agent-reach/source`。CLI位于HOME下 `.local/bin/agent-reach`。代理沿用本机127.0.0.1:7890，不读取/修改原X浏览器。服务不继承网关环境密钥。

浏览器服务 `openclaw-reach-browser.service` 独立持有浏览器进程，CDP和OpenCLI bridge仅监听127.0.0.1:9222/19825。ProtectHome、ProtectSystem、NoNewPrivileges及独立可写目录保护宿主配置。请求在独立systemd transient unit运行，限墙钟、限制输出并控制整个进程组。浏览器槽位排队也计入外层预算，不因上游内部暂停计时而无限等待。

通常请求60秒，字幕/小红书评论90秒。没有失败后自动换账号或绕过限流/挑战。Reddit的公开后端在执行前固定选定，不是触发封锁之后自动切换。

入参使用严格schema和对应站点HTTPS域名/路径约束，以argv调用固定可执行文件，不通过shell；`--`隔离用户查询。结果去除raw和敏感运行信息，正文总上限26000字符。错误只暴露固定业务说明，保留退避秒数。

## 运维与登录

仅管理员在主机执行，不向聊天模型开放管理入口：

```bash
/opt/openclaw-agent-reach/admin-command doctor
/opt/openclaw-agent-reach/admin-command browser status
systemctl status openclaw-reach-browser.service
```

小红书复用了旧账号的站点限定Cookie，但实测仍需重新登录。没有复制其他站点Cookie，也未启动旧SMS流程。管理员可生成独立浏览器二维码截图：

```bash
runuser -u openclaw-reach -- env -i \
  HOME=/var/lib/openclaw-agent-reach \
  PATH=/var/lib/openclaw-agent-reach/.local/bin:/usr/bin:/bin \
  /var/lib/openclaw-agent-reach/.local/share/uv/tools/agent-reach/bin/python \
  /opt/openclaw-agent-reach/prepare-xhs-login.py
```

截图保存为 `/var/lib/openclaw-agent-reach/.agent-reach/login/xiaohongshu-login.png`，0600。二维码有效期短，过期后重跑刷新；使用当前账号扫码完成后再复测业务。脚本优先捕获上层账号安全验证二维码，保留待完成验证页面，不重载；短信验证待处理时不会误截底层登录二维码。登录是否成功必须以站点loggedIn及实际业务结果共同确认，不能仅依据弹窗关闭判断。脚本仅准备页面及截图，不代替用户确认登录。本次没有添加自动私聊admin发登录通知的逻辑。

B站复用现有bilibili-notify登录，只将所需站点字段导入Reach自己的bili-cli credential，未更改原监控、refreshToken或订阅。迁移脚本位于 `integrations/agent-reach/import-bilibili-session.mjs`，原始密钥和Cookie不写入日志。小红书定域迁移脚本同目录 `import-xhs-session.mjs`。

## 实测与验收

- 全量352项单元/回归测试通过，包含19工具schema、权限矩阵、多用户隔离、取消和输出过滤；351项基线日志 `/tmp/reach-final-suite.log`，新增后台跳过回归 `/tmp/reach-new-final-tests.log`，最终部署脚本重新验证全量。
- `openclaw config validate`通过；全局agent-reach-ops skill为Ready、模型可见。
- GitHub仓库搜索与README读取成功；V2EX热门成功。
- YouTube元数据成功；`UF8uR6Z6KLc`的英文字幕成功，11964字符文本。
- B站视频元数据成功；测试视频`BV1xx411c7mD`在复用认证后返回NOT_FOUND（无字幕）。字幕工具已接入，但没有在有字幕样本上完成成功验收。
- Reddit公开搜索及公开帖子读取成功；OpenCLI站内帖子/版块样本返回UPSTREAM_BROKEN（返回非JSON），站内路径未验收成功。公开搜索不保证站内排序、实时性、全文或全评论。
- 小红书返回NEED_LOGIN，不能宣称搜索、详情或评论已真实通过。扫码后需再验收。
- `scripts/accept-reach-live.mjs`用真实provider经过业务OperationStore，再调用真实角色模型改写；QQ目标为127.0.0.1捕获服务，不向真实用户/群发测试消息。结果在 `/root/.openclaw/state/reach-acceptance-20261023/report.json`。本次Gemini主模型503（配额冷却），由现有novacode/qwen3.8-flash-next备用链完成，角色总结及模拟投递耗时约42秒。以文件实际ok为准。
- 保留旧小红书代码回归：`tests/helpers/legacy-xhs-config.mjs`仅在测试临时目录启用旧后端，避免为了测试在生产恢复旧下载权限。

最终部署重启完成：北京时间2026-10-24 01:25:45两个QQ账号均Gateway ready；最终启动无旧小红书服务失败或Unknown feature。旧X及Bilibili监控feature配置与迁移前备份一致。

测试中的错误分类、字幕缺失、公开网页范围不是平台全功能通过。任何后续登录操作和二维码失效都不改变上述范围。

## 备份与恢复

迁移前备份：`/root/.openclaw/state/backups/agent-reach-migration-20261023T165311Z`，包含旧配置、原小红书skill及相关源文件。每次部署的dist备份路径见 `/tmp/reach-deployment.log`。新旧方案都不删除登录数据。

恢复旧小红书时先检查备份后是否还有其他配置更新；仅恢复小红书backend、旧执行器开关、media权限和原skill，关闭`reach_xhs_*`及Reach小红书平台，再部署及重启网关。不要盲目覆盖整个openclaw.json或重置无关改动。恢复业务不要求删除Reach独立环境，也不应操作原X浏览器。

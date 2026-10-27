# Agent-Reach 小红书媒体接入（2026-10-26）

新实现复用 Reach 专属用户、浏览器与当前登录会话，未恢复原 Komachi HTTP 搜索接口。项目内维护 `integrations/agent-reach/xhs-media.py`，通过固定包装器在 openclaw-reach 用户、受限 systemd 单元中执行。它仅读取站点搜索、帖子结构化数据和公开博主页面；不向模型或群聊导出 Cookie。源码更新和安装副本、两个业务 skill 已纳入 deploy。

## 配置与数据

- onebot-xhs.json：backend=agent-reach，mediaEnabled=true，reachRecovery.enabled=true。
- 新业务数据目录：`/root/.openclaw/state/business/xhs-reach`；旧 `/root/komachi-xhs-js/data/xhs-public` 保留，不启动其历史任务。
- 原 HTTP/SMS/manualVerification 关闭；Reach 现有浏览器不重启、不登出。
- read/media 使用既有 public 身份配置及配置群列表；仍按机器人账号、群和实际入站用户重新授权。
- 搜索/详情/媒体产物/下载/投递各自有独立状态；发送回执是唯一成功依据。

## 实现

- `src/src/xhs/backends/reach.js`：固定 JSON 参数调用、只读请求合并、45秒提取缓存、每个等待者独立取消。
- `integrations/agent-reach/xhs-media.py`：同时兼容 Vue value/_value；保留图片全部顺序和 URL 参数；只取当前 note ID，区分视频与封面。视频无标题时使用标注为“无标题”的正文首行作为显示标题。
- `features/reach-provider.js`：搜索文字工具保留可见点赞数、作者链接，推算日期不冒充准确发布时间。
- `xhs/service.js`：完整图集、媒体解码/视频流校验、30分钟内容缓存；缓存复制生成各自资源句柄，不共享用户授权。临时网络错误最多重试一次，登录、限流和权限拒绝不重试。现有额度、TTL清理继续生效。
- `features/xhs-workflow.js`：默认搜索12条，候选内高赞排序；详情与列图复用已提取清单，轮询时长聚合。近期30分钟本会话已发送帖子优先避开，明确链接不替换。
- `features/xhs.js` / delivery：每帖一个节点，标题及全部图片同节点；所有帖子一条合并消息，文本另发。缺图不发残缺图集；不确定回执不重复投递。
- `features/xhs-reach-recovery.js`：登录失效/安全验证暂停原任务，只有 admin 私聊收到二维码；区分普通登录和上层安全验证。页面 loggedIn 和真实搜索共同验证后，重新授权，最多恢复一次。重启时不重放处于 resuming 的不确定任务。
- gateway：文字生成和下载并行，媒体回执后的文字等待最多12秒，超时使用现有事实回执文案；不再等完整下一轮主模型回答。

## 能力限制

高赞仅代表本次候选内比较；万/亿等是近似计数。当前未实现 latest 过滤，返回明确不支持。公开博主笔记仅页面已加载部分，不宣称全量；粉丝数只依据来源标签，不将获赞收藏当粉丝。评论仍由 reach_xhs_comments 执行。单文件25MiB、图集/合并总量及QQ发送限制仍生效。

## 已完成验收

- 全量 Node 测试395/395通过，130个源码文件检查通过，包含原完整图集23图、多身份/账号/群、跨用户句柄拒绝、权限撤销、不确定回执防重、取消、并发等。
- 新增页面 JS 提取测试：Vue refs、视频类型、图片顺序/签名参数、安全验证优先、博主计数语义。
- 新增恢复测试：只向 admin 发二维码、实际搜索前不恢复、未登录弹窗关闭不算成功、二次受阻不循环登录、原权限撤销不恢复。
- 真实图片下载：9图全部成功，无缺失；视频MP4约2.57MB解码校验成功；真实公开博主资料读取成功。
- admin 私聊真实合并图片消息：2帖，共10图（3+7），31秒左右，实际QQ回执已获得。
- admin 私聊真实合并视频消息：1个MP4，约21秒，实际QQ回执已获得。
- 真LLM/真站点/出站捕获入站验收：admin图片2帖10图，入站至合并回执50.382秒；guest群视频45.727秒，7.8秒后独立人设文字。
- 4个并发实际媒体任务通过：default admin私聊、guest私聊、guest群、yuexia guest群，分别约7.2/2.6/2.9/3.1秒（已有缓存），不同投递ID与目标。首次并发遇下载超时，完整性保护阻止残缺图集，增加有限重试后复测。
- 最后原始示例消息完整复测：3帖12图（3+7+2），入站至合并消息43.637秒，10.343秒后发送主模型生成且审查通过的独立人设文字，finished=true。结果见 live-reach-20261026-final-admin/result.json。

实际登录失效恢复使用模拟故障验收，没有故意登出刚登录的生产账号。定时任务配置总检脚本发现历史一次性Qzone重试任务已不存在；与本功能无关，没有修改该历史绑定。

## 产物

`/root/.openclaw/state/analysis/reach-xhs-20261026-*`；入站报告在 `/root/.openclaw/state/xhs-integration-20261021/live-reach-20261026-*`。报告保留身份范围与真实/捕获发送标记，敏感文件保持0600。

## 回滚

配置快照 `/root/.openclaw/state/backups/reach-xhs-enable-1792997424654156975`；部署快照路径见 deploy-final 日志。若回退只关闭 mediaEnabled/媒体执行器和媒体权限，并恢复适用版本源码/skill，保留 Reach 登录浏览器。不要全量覆盖其他正在更新的配置，不自动恢复旧HTTP任务。

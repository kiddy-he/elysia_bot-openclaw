# 小红书业务接入（2026-10-21）

业务代码从 `/root/komachi-xhs-js/src/` 迁入 `src/src/xhs/`，保留 MIT LICENSE/NOTICE。适配层为 `src/src/features/xhs.js`，由现有 OneBot 插件注册工具与后台服务，不启用原独立插件。依赖已写入 package.json/package-lock.json；deploy 在校验通过后安装锁定依赖、保留运行插件元数据，并发布 JS、类型声明、浏览器静态资源及版权文件。

## 账号、权限与模型路由

继续读取当前已登录账号的会话目录，配置在 `/root/.openclaw/onebot-xhs.json`；不复制、不导出认证文件。业务后端仅 HTTP，工具不包含登录、发布、点赞、收藏、关注或评论写入。

`onebot-features.json` 中 `xiaohongshu.read/media` 绑定 `public` profile，groupIds 包含当前接入的全部群聊。爱莉、月下允许所有用户在已接入私聊和群聊使用。身份取自本轮入站事件，模型参数不能指定账号、用户、路径或收件人。执行、后台下载及投递前都会复查授权。

原有入站模型增加 `xiaohongshu_operation` 语义字段，不靠消息正则判断。当本轮为小红书内容任务时，只向模型提供已授权的小红书工具和适用的语音工具；拒绝 shell、文件、其他业务和额外网页工具，避免在下载过程中自行检查本地配置或产生额外审批。纯内容任务使用小红书检索，不重复 Google 搜索；服务器部署、插件排障或混合任务不适用此限制。

## 工具

| 工具 | 用途 |
| --- | --- |
| xhs_search_posts | 搜索当前可见候选，最多返回 12 条 |
| xhs_inspect_posts | 核对帖子正文、作者、互动数和标签 |
| xhs_get_profile | 查看博主资料，可选一页发布笔记 |
| xhs_read_comments | 查看评论；站点挑战返回明确错误 |
| xhs_list_images | 取得本帖图片句柄 |
| xhs_download_images | 选定帖子并自动下载其完整图集 |
| xhs_download_video | 排队下载兼容 MP4 视频 |
| xhs_job_status | 查询最新状态，最多等待 10 秒 |
| xhs_cancel_job | 取消本人在当前会话的下载任务 |
| xhs_read_artifact | 校验产物并暂存到本轮合并批次 |
| xhs_send_media | 将本轮已选图片及视频作为一条合并消息回传 |

“点赞较高”在本次搜索候选中按 metrics.likes.value 比较，核对详情后选择；不能声称全站最高赞。输入“爱莉西雅”可以由模型按语义使用“爱莉希雅”搜索。默认“一些图片”选择 2—3 个帖子，每个帖子均发送完整图集。

## 下载、续查与回传

搜索/详情 → 图片列表 → 图片下载；视频直接以完整原帖 URL 下载。accepted 仅为排队，job_status 须确认 state/result，之后 read_artifact 暂存全部所需媒体，再 xhs_send_media 一次性合并发送。每帖全部图片放在同一节点，不同帖子分为独立节点，视频帖包含原生视频，文字回复单独发送。视频选择与实际下载均受 QQ 投递的 25MiB 上限约束。

每条原始请求独立计算四次搜索预算和 terminal 状态。任务、图片、游标、产物通过持久 owner 映射允许跨轮续查，必须属于同一机器人账号、发起用户和当前会话；不能混用来自不同原始请求的图片句柄。对于模型误传的纯帖子 ID，仅从当前请求已搜索到的候选恢复原始完整 URL，不猜定位 token。

job_status 和 read_artifact 的新调用会刷新状态；下载创建仍幂等。投递按机器人账号、用户、当前会话及入站消息批次去重；同一轮重复发送工具复用回执。跨轮仅读取或暂存不会自动发送，显式提交新一轮批次可再次发送。下载文件根据校验结果保存真实扩展名；聊天结果不暴露本地路径。只有 delivered + 实际 QQ receipt 才报告发出。

LLBot 私聊文件上传可能只返回 file_id。发送后会查询该私聊历史，核对新出现的己方文件、时间、文件名与字节数，取得消息 ID；无法确认时保留不确定状态，不盲目重传。任务进度区分排队、下载失败、部分成功与投递不确定。

## 验证

- `npm test`：包含平台权限矩阵、跨轮句柄、后台撤权、下载与投递去重、challenge 停止、状态刷新、模型路由、文件回执等测试。
- `npm run deploy`：完整测试与语法检查通过后发布。
- `node scripts/accept-xhs-live.mjs <fresh-live-root>`：显式验收，注入模拟已授权用户入站事件，调用真实模型和真实小红书，并按验收模式发送至授权目标或隔离捕获目标；仅用于已授权的验收。必须使用新的 `/root/.openclaw/state/xhs-integration-20261021/live-*` 目录。可用 XHS_ACCEPT_MESSAGE 指定消息；默认使用用户给出的高赞 coser 图片示例。

真实验收证据和完整日志保存在 `/root/.openclaw/state/xhs-integration-20261021/`。根目录的 summary.json/ACCEPTANCE.md 记录最终状态；中途失败或中断的目录不视为验收通过。

## 已知限制

搜索只取第一页；sort 支持 relevance/latest，没有 likes；tag 复用关键词接口。缩写互动数标 approximate，缺失不当 0，博主 liked/collected 不当粉丝数。评论及博主分页不保证无遗漏。遇 challenge_required/login_required/rate_limited 停止当前请求，不自动换账号、重登或绕过验证。

全局 modular/features 检查另有既存空间重试任务绑定缺失：`c820ba71-8a1f-5647-af90-4f4d92117e23`。它不是小红书接入造成，本次未变更该调度。

## 小红书合并媒体回传

OneBot 提供 11 个业务工具（底层 XHS 服务仍为 10 个，新增 xhs_send_media 为 OneBot 投递工具）。read_artifact 校验后仅暂存媒体；全部选完后 xhs_send_media({}) 按帖子将本轮图片及原生视频构造成 node：同帖全部图片一个 node，不同帖子不同 node，一条 send_private_forward_msg / send_group_forward_msg 回传当前会话。文字总结经普通文本链路单独发送，网关在最终回复前检查是否有遗漏的待发批次。

节点发送人使用机器人实际账号，内容仅 image/video，不能由模型指定收件人、节点文字或其他消息类型。每文件25MiB、每批最多64个帖子节点和160个媒体且总计100MiB；完整图集超过上限时报错，不能静默截断。持久队列保存嵌套媒体路径，清理器保护尚未完成的批次；发送和恢复前重新检查权限。同一入站消息仅提交一批，复用队列回执避免重发。失败或回执不明确时报告状态，不退化为逐张发送。

完整图集由执行器强制保证：download_images 的 image_ids 选择帖子，自动从已核对详情扩展到整帖全部图片，不受 list_images 一页20张限制。下载结果记录 album_total；read_artifact 可用该帖任一产物暂存整个完整图集，缺张、损坏或超限时拒绝发送该帖部分图片。发送前再次核对张数、索引及归属并按原始 media_index 排序。

合并接口实际等待120秒，工具执行上限180秒，防止多图上传超过原普通API的15秒等待而误报未送达。再次调用 xhs_send_media 仅刷新原投递状态；不能用 job_status 判断 QQ 是否已发送。实现与 LLBot 源码核查见 QQ-FORWARD-MEDIA.md。

2026-10-21 标题格式补充：每个帖子独立节点，节点第一个段是普通文本 `【帖子标题】`，后接该帖完整图片或视频；所有帖子节点只发送一条合并消息。标题来自已校验产物的帖子元数据，回复总结文字仍单独发送。搜索优化、跨轮去重及耗时审计见 [XHS-PIPELINE-AUDIT.md](XHS-PIPELINE-AUDIT.md)。

## 2026-10-21 公开内容权限与串行队列

`xiaohongshu.read/media` 均使用 public profile，允许 admin、member、visitor 在当前已接入会话调用全部11项内容工具；两个机器人账号复用现有XHS登录态。群聊范围是当前渠道已接入的全部群聊，后续新增群聊须按常规渠道配置登记。群聊艾特/角色触发规则不变。

所有XHS前台工具共享有界FIFO（最多64个等待项），不会因同账号并发直接返回“正在执行”。等待和执行共享该工具的超时（list_images为90秒），支持取消；等待结束后重新检查工具开关、身份和动作授权。按现有单一XHS登录态对两个机器人账号统一串行，底层下载任务仍由后台工作器管理。并发相同操作复用已有记录，不重复执行。

资源句柄绑定机器人账号、请求用户和会话；群内其他成员、其他群、私聊不能复用。发送目标从实际入站事件固定：私聊回本人、群聊回本群，模型无收件人参数。撤销权限后前台、后台和投递前继续检查。

登录/会话维护、Cookie或凭据导出、切换账号和配置修改不注册为聊天工具。点赞、收藏、发评论、关注、发布/删除笔记等平台写操作目前也不在业务工具中；将来接入时宜仅管理员可用。cancel_job仅能取消当前用户、当前会话归属的下载任务，不能管理其他人的任务。


## 461 人工验证通知（2026-10-22）

`features/xhs-verification.js` 在真实业务返回 `challenge_required` 后启动可信的 `scripts/xhs-verify.mjs`。`onebot-xhs.json.manualVerification` 配置开关、既有 HTTPS origin、本地交互端口及浏览器路径。仅生产配置根可启动；模拟环境不会连接生产账号。

保持原有 HTTP 业务实现。运维脚本持有单账号锁，以当前会话打开站点页面，临时凭证仅通过默认机器人私聊发送给 `identities.adminIds ∩ accounts.default.privateAdminIds`。普通用户、群聊及模型只得到 requested/pending/cooldown 状态。已有任务和三十分钟冷却抑制重复链接；状态文件不保存 URL、token 或 cookie。

约五分钟内由 admin 人工操作并点击确认。验证页面无可见挑战且已登录后才保存会话，随后单次 HTTP 搜索检查，另发结果通知。验证期间新上游调用返回 `manual_verification_pending`；本地查询、已有媒体投递不受此门控。失败原任务不会自动重放；网页登录成功不等同于接口解除限制。浏览器未出现挑战组件时也不能保证可完成验证。

新增测试覆盖确认接口鉴权与模式绑定、人工确认前不保存、挑战未解除不保存、通知去重和模拟根隔离。公网 fixture 报告位于原项目 `deploy/xhs-login/manual-verification-gateway-test.json`，无真实站点请求。

## 群聊并行执行流（2026-10-22）

群聊中的不同成员使用各自稳定的模型会话，独立绑定工具身份、进度和投递上下文；不会因多人同时艾特而产生共享 session 的身份歧义。XHS 单登录账号的 API FIFO 和下载资源限制继续保留。架构、管理控制及并发验收见 [群聊成员并行对话与工具执行流](GROUP-CONCURRENT-STREAMS.md)。

## 2026-10-22 批量媒体工作流提速

新增 xhs_media_workflow，媒体搜索请求优先一次执行搜索、核对、完整图集下载及合并发送。当前共12项XHS内容工具；复杂选帖仍支持旧工具链。两个真实QQ私聊样本入站到媒体回执为29.265秒（3帖10图）、63.000秒（3帖27图），群聊模拟回执样本25.617秒。详细边界、测试与部署见 [批量工作流提速验收](XHS-FAST-WORKFLOW-20261022.md)。

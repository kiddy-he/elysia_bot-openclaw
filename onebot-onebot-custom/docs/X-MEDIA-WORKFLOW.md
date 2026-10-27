# X 搜索、帖子查看与完整媒体回传

实现日期：2026-10-23。X/Twitter 只读工具已经接入 OneBot 的业务权限、入站语义分类、操作账本和统一持久投递队列。没有接入发推、点赞、关注、私信、账号管理或 RSS 定时订阅工具。

## 对话入口

- “在 X 上找两条点赞比较高的爱莉西雅 cosplay 帖子，把图片发我。”
- “下载这个推特帖子的图片和视频：https://x.com/用户名/status/帖子编号”
- 直接向机器人发送一个 X/Twitter 帖子链接：默认提取该帖完整媒体。
- “查看这个 X 帖子的内容”：使用详情工具，文字说明，不默认另行发媒体。

现有私聊准入和群内艾特触发规则继续生效。合并／引用材料里的链接本身不是下载命令，需要当前发送者表达查看或下载意图。分类由原有入站 LLM 的 `x_operation` 字段完成，不使用本地关键词或正则路由；URL 校验中的模式仅用于检查合法帖子地址。

| 工具 | 功能 | 参数 |
| --- | --- | --- |
| `x_search_posts` | 搜索最多20条公开候选帖子，返回正文、作者、点赞、媒体数量 | `query`，可选 `limit`、`rank`、`media_type` |
| `x_inspect_posts` | 查看最多3条帖子的完整元数据 | `ref_ids` |
| `x_media_workflow` | 一次完成搜索或链接详情、完整媒体下载和合并发送 | `query` / `ref_ids` 二选一；可选 `post_count` 1–3、`rank`、`media_type` |

`rank=likes` 只对本次搜索候选按点赞数排序，不代表全站最高赞。`media_type=auto|image|video` 用来筛选帖子，混合帖子仍下载和发送全部图片、视频，不因筛选而截断图集。普通搜索默认选择3帖；明确链接按指定帖子处理，不扩展无关帖子。正文等站外内容视为不可信资料，不能成为工具指令。

## 执行和消息格式

关键词请求在宿主内串起确定的步骤：搜索20个候选 → 去重、按要求选帖 → 详情核对 → 最多3路并发下载完整媒体 → 解码校验 → 持久化成品 → 原生持久队列 → QQ 回执。模型不需要逐步规划下载、反复查询任务或手写命令。

每个帖子一个合并转发节点：`【帖子标题或原文摘要】【图片】【图片】…【原生视频】`。多个帖子在同一条合并消息中，回复文字另外发送。X 没有独立标题时取原文前180字符；空原文使用作者名称和“的帖子”。任一选中帖的任一媒体失败就停止整批，不发送残缺图集。图片做实际解码检查，视频检查 MP4/H.264 和音频兼容性，并抽帧验证。QQ 限制：单图8MiB、单视频25MiB、整批100MiB；超限返回错误，不静默跳过或压缩少发。

同一原始消息的并发重复工具调用共用执行；参数改写也不能在本轮重复发送。先检查投递账本再访问上游；成功复用回执，发送结果不确定时不自动重发。不同用户独立处理，不加整群工作流锁；同一投递目标仍保持队列顺序。排队期间取消或权限撤销可阻止后续发送，已开始的平台发送通过账本核对结果。

只有 `delivery_status=delivered` 且有 `receipt` 才表示发送确认；模拟接收端的测试回执不代表真实 QQ 平台已经收件。`auth_required`、`session_invalid`、`rate_limited`、`challenge_required`、`post_unavailable`、`no_media`、`invalid_image`、`invalid_video`、`download_size_limit` 和不确定投递是不同状态，不转换成虚假的空搜索成功。

## 权限和运行配置

`onebot-features.json` 新增独立 `x` 模块，动作 `read`、`media`，当前用 `public` profile，向已准入的管理员、普通群友和私聊访客开放，default／yuexia 两账号均可用，只能回传当前群或私聊本人。群范围沿用当前已配置的小红书公开群；未知群、被禁账号、内部代理／服务身份不获得转发授权。工具没有目标群号、任意 URL、路径、Shell、Cookie 或账号参数。执行和出队时分别重新授权。

`onebot-executors.json` 登记三个执行器，搜索／详情最长45秒，完整工作流180秒，每账号最多4个业务调用并发。可单独禁用或降低限额。阶段耗时以 `[onebot-x] stage=… elapsed_ms=…` 记录；结果和安全错误码保存在操作账本，原始HTTP响应、Cookie、签名媒体地址不写入工具返回。

`/root/.openclaw/onebot-x.json` 控制只读适配器：

```json
{
  "version": 1,
  "enabled": true,
  "publicLinks": true,
  "python": "/root/.openclaw/onebot-onebot-custom/integrations/x-media/.venv/bin/python",
  "bridge": "/root/.openclaw/onebot-onebot-custom/integrations/x-media/bridge.py",
  "accountsDb": "/root/.openclaw/state/x-media/accounts.db",
  "proxy": "http://127.0.0.1:7890"
}
```

公开链接在无登录会话时使用 FxTwitter、syndication 的公开元数据，检查返回帖子 ID，媒体只允许 `pbs.twimg.com/media/` 和 `video.twimg.com/*.mp4`，拒绝任意主机、私网、恶意重定向、凭据URL和不完整下载。该路径依赖第三方公开解析的可用性，删除／受保护／不受支持的媒体不会保证可取。

本机系统 DNS 对部分 X 域名解析异常，因此 X 配置使用显式本机 HTTP 代理。通过固定 Cloudflare DoH 解析真实公网 IPv4，再对该 IP 建立 CONNECT 隧道；TLS 验证原站域名，重定向仍检查媒体 CDN 白名单。代理只接受管理员配置的回环 HTTP 地址，不接受模型或用户提供代理。未配置代理时使用直接公网地址校验下载。

## 关键词搜索登录准备

搜索使用隔离 Python 环境中的 `twscrape==0.20.1`。已安装依赖；完整依赖版本见 `integrations/x-media/requirements.lock`。新机可运行：

```bash
/usr/bin/python3.12 -m venv integrations/x-media/.venv
integrations/x-media/.venv/bin/pip install --index-url https://pypi.org/simple -r integrations/x-media/requirements.lock
```

2026-10-23 已从独立登录浏览器导入当前管理员的 X 会话，账号库检查为1个账号、1个活跃账号，并已完成真实关键词检索和完整媒体工作流验收。账号库权限为600，导入临时文件已清理。独立浏览器登录和安全导入步骤见 [X-BROWSER-LOGIN.md](X-BROWSER-LOGIN.md)。公开链接仍支持无登录解析；没有暴露登录管理聊天工具，也不借用 QQ 或小红书登录。

账号只由本机管理员导入。准备一个权限600、当前管理员拥有的普通 JSON 文件，字段是 `auth_token`、`ct0`；不要向群聊或模型粘贴 Cookie。使用实际用户名替换下方 `YOUR_USERNAME`，私有文件路径替换示例路径：

```bash
integrations/x-media/.venv/bin/python integrations/x-media/accounts.py import /root/.openclaw/state/x-media/accounts.db YOUR_USERNAME /root/private-x-cookie.json
integrations/x-media/.venv/bin/python integrations/x-media/accounts.py status /root/.openclaw/state/x-media/accounts.db
```

CLI 仅输出账号数量、活跃数和是否配置就绪，不输出 Cookie／账号明细。导入成功表示本地配置存在，能否查询仍须上游验收；无需重启业务服务。桥接进程最长35秒、账号等待最长10秒，不会因为没有可用账号无限挂起；限流／验证不会触发换号或绕过逻辑。上游登录过期需管理员本机更新，不向 guest 索取凭据。

## 已完成验收

- 专项测试覆盖 URL／CDN与参数边界、伪造帖子ID、完整多帖图集、图片视频混合、损坏媒体、不完整下载、登录缺失／限流／验证、不确定投递去重、不同用户并发、8种账号身份会话组合、权限撤销和排队取消。
- 真实公开帖子 `1577855540407197696`：1图1视频实际下载、解码、持久化成功，业务链约3.06秒；投递在测试接收端捕获，未联系真实群。
- 隔离网关、真实入站分类与主模型、普通群成员艾特消息：`x_operation=true`，只调用一次 `x_media_workflow`。入站至捕获合并消息25.385秒；节点为 text/image/video，标题正确，最终说明单独发送。没有对真实群执行测试发言。
- 登录前的隔离网关、管理员私聊关键词请求：模型调用一次工作流，搜索在182毫秒返回 `auth_required`，最终只发登录未配置说明；没有媒体合并消息，没有伪造搜索候选。另用真实入站分类验证裸链接为X任务，数学变量x和仅翻译引用中的搜索请求都不触发X工具。
- 复现脚本 `scripts/accept-x-live.mjs` 固定捕获所有发送；结果在 `state/x-integration-20261023/live-*`，不能把捕获回执当真实平台验收。这是登录前的历史入站验收；登录后的真实上游验收见下一项。

- 2026-10-23 登录后实测：`Elysia cosplay` 真实搜索约3.85秒，返回20条候选。完整业务工作流约10.13秒，搜索3.563秒、详情4.235秒、下载及校验2.324秒、捕获发送0.007秒；选中2帖共2图，每帖一个节点，全部节点合成一条转发。使用真实上游、生产权限和持久投递队列，发送函数由测试端捕获，未实际向QQ发送；此时长从业务工具执行开始，不包含入站模型分类和最终文字回复。记录见 `X-MEDIA-LOGIN-VERIFICATION-20261023.json`。

验收汇总见 `X-MEDIA-ACCEPTANCE-20261023.json`。全量Node测试和120个源码文件检查已通过，正式服务已重载，两个OneBot账号均重新连接。额外运行 `scripts/features.mjs check` 时发现已有的 `qzone-elysia-prepare-retry-2026-10-20-2` 自动任务绑定缺少对应任务；该绑定在本次修改前的配置备份中已经存在，未修改这项历史QQ空间配置。X模块配置／执行器校验正常，此问题与X工具注册和投递无关。

2026-10-23 更新：媒体发送后的最终文字已接入并行准备、真实回执后快速收尾，审查通过后不再重复改写。适用范围、等待预算和验收见 [MEDIA-COMPLETION-20261023.md](MEDIA-COMPLETION-20261023.md)。

---
name: qzone-ops
description: 通过本机 LLBot 查询 QQ 空间说说、好友动态流和配图，或按用户明确授权发表评论、点赞及发布说说。用于 QQ 空间相关请求。
metadata:
  openclaw:
    requires:
      bins: ["node", "python3", "ffmpeg", "ffprobe", "flock"]
---

# Qzone Operations Skill (`qzone-ops`)

本技能允许 OpenClaw Agent 或定时任务通过本地 LLBot 提供的 QQ 空间凭据，安全地执行 QQ 空间动态（说说）检索、图片获取、评论回复、点赞互动及自主发布动态等操作。

查询与测试默认只读。发布、评论、点赞、取消点赞或删除仅在用户明确授权对应操作和目标后执行；查询某人的空间不代表授权互动，也不扩大群聊访客的工具权限。

脚本依赖本目录的 `acorn`（由 `package-lock.json` 固定）；缺少依赖时，在本目录运行 `npm ci --ignore-scripts --no-audit --no-fund`。

---

## 一、系统架构与鉴权机制

1. **凭据桥接**：
   - 自动向本地运行的 LLBot（主账号 `default/700000006`、月下账号 `yuexia/700000005`）拉取 `qzone.qq.com` 域下的 Session Cookie。
   - 包含必要票据：`uin`, `skey`, `p_skey`, `pt4_token`。
2. **算法关键（`p_bkn`）**：
   - 针对发说说、发评论及点赞等写操作 CGI，腾讯强制校验 `p_skey` 计算出的 CSRF Token（即 `p_bkn`），若使用普通 `skey` 计算的 `bkn` 会报 `-3000 请先登录空间`。
   - 算法公式：
     ```js
     let hash = 5381;
     for (let i = 0; i < p_skey.length; i++) hash += (hash << 5) + p_skey.charCodeAt(i);
     const p_bkn = (hash & 2147483647).toString();
     ```
3. **域名路由规范**：
   - 所有的写操作请求（发说说、评论、点赞）与列表拉取请求统一通过 `https://user.qzone.qq.com/proxy/domain/...` 代理反向网关进行，避免直连 `taotao.qzone.qq.com` 触发 WAF 403 / 500 拦截。

---

## 二、核心功能与接口协议

### 1. 获取好友/自身动态与图片 (`msglist` / `feeds`)

- **说说列表 CGI 地址**：`https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6?uin=<目标QQ>&num=<数量>&format=json&g_tk=<p_bkn>`
- **好友动态流**：`feeds` 查询当前登录账号的好友动态流；查询指定 QQ 的空间请用 `msglist --target <QQ>`，不要将好友动态流当作指定空间的说说列表。
- **响应兼容**：接口虽接受 `format=json`，仍可能返回带未加引号字段、单引号和 `undefined` 的 JavaScript 数据对象或 JSONP。客户端仅解析其数据语法树，不执行脚本；`undefined` 转成 `null`。HTTP、解析或非零业务码错误以失败退出，不把错误页面当作查询成功。
- **返回结构解析**：
  - **动态文本**：位于 `.msglist[].content`。若包含文字说明，会同时记录在 `.conlist[].con` 中。
  - **动态图片**：位于 `.msglist[].pic` 数组中：
    - 原图高清直链：`pic[].url1` 或 `pic[].url2`（带签名的大图 CDN 链接）；
    - 预览缩略图：`pic[].smallurl`；
    - 图片尺寸与数量：数组长度即配图数，含 `pic[].pictype`、`pic[].wh_rad`。
  - 图片链接可能返回 HTTP 200 的“主人已删除”等占位图，不能仅凭状态码或图片 MIME 判断原图可用。
  - **说说唯一标识**：`.msglist[].tid`（例如 `161099446ca9cc6a692e0c00`），后续评论和点赞均以此 `tid` 为唯一目标键。
  - **评论列表**：位于 `.msglist[].commentlist`，内含评论的 `tid`（评论序号）、`uin`（作者）、昵称与内容；`list_3` 是该评论下已有的原生回复。注意说说 `tid` 和评论 `tid` 是两个不同字段，不能混用。

### 2. 发表空间评论 (`comment`)

- **CGI 地址**：`https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds?g_tk=<p_bkn>`
- **请求方式**：`POST (application/x-www-form-urlencoded)`
- **核心 Payload**：
  ```
  topicId: <目标QQ>_<tid>__1
  feedsType: 100
  hostUin: <目标QQ>
  uin: <当前操作机器人QQ>
  content: <评论文字内容>
  format: json
  plat: qzone
  source: ic
  platformid: 52
  ```
- **成功标识**：返回 `{"code": 0, "subcode": 0, "message": ""}`。

### 2.1 直接回复已有评论 (`reply`)

- 用户要求“回复评论 / 回复留言”时，必须使用 `qzone_interact action=reply` 或下述 `reply` CLI；`comment` 仅创建新一级评论。不得拼接 `@{uin:...,nick:...}`，也不得合并多人回复后作为一级评论发送。
- 先读取说说的 `commentlist`，逐条使用原评论的 `tid` 与 `uin`，转为字符串填写 `commentId` / `replyUin`；说说主人、说说 ID 另填 `target` / `tid`。当前入口直接回复 `commentlist` 中的原评论；不得把 `list_3` 中的局部序号冒充原评论 ID。找不到原评论时先重新查询，不猜 ID。
- CGI 仍为 `emotion_cgi_re_feeds`，`paramstr=2`，同时携带 `commentId` / `commentUin`、`t1_uin` / `t1_tid` / `t2_uin` / `t2_tid`，正文只写回复内容。原评论和作者会在发送前用最新 20 条说说校验，目标不在其中时停止发送。
- 返回成功后回读原评论的 `list_3`，确认本账号与正文匹配后才报告成功；接口返回成功但没有关联到原评论时标记结果不确定，绝不降级为一级评论或艾特。
- 按“机器人账号 + 说说主人 + 说说 ID + 原评论 ID + 原评论作者”持久化去重，记录在 `/root/.openclaw/state/qzone-interactions/replies/`，不会因更换措辞、消息、工具调用 ID 或重启而重发。正文仅保存哈希；日志不保存票据。超时、进程中断、回读未确认时禁止自动重试，须先核对实际结果。
- 对话中临时发起的空间互动继续逐项审批。工具先登记唯一审批再异步投递，不等待无法改变人工确认要求的模型审查；等待期间不要改写内容重试。审批确认仅执行原参数一次。下述用户明确授权的固定巡检任务按其限定能力自动运行，不逐条再审批。

### 3. 说说点赞与取消点赞 (`like`)

- **CGI 地址**：
  - 点赞：`https://user.qzone.qq.com/proxy/domain/w.qzone.qq.com/cgi-bin/likes/internal_dolike_app?g_tk=<p_bkn>`
  - 取消赞：`https://user.qzone.qq.com/proxy/domain/w.qzone.qq.com/cgi-bin/likes/internal_unlike_app?g_tk=<p_bkn>`
- **请求方式**：`POST (application/x-www-form-urlencoded)`
- **核心 Payload**：
  ```
  opuin: <当前操作机器人QQ>
  unikey: http://user.qzone.qq.com/<目标QQ>/mood/<tid>
  curkey: http://user.qzone.qq.com/<目标QQ>/mood/<tid>
  appid: 311
  typeid: 0
  fid: <tid>
  format: json
  ```
- **成功标识**：返回 `{"code": 0, "message": "succ"}`。

### 4. 自主发布动态说说 (`publish`)

- **CGI 地址**：`https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6?g_tk=<p_bkn>`
- **请求方式**：`POST (application/x-www-form-urlencoded)`
- **核心 Payload**：
  ```
  syn_tweet_version: 1
  con: <发布文字内容>
  hostuin: <当前操作机器人QQ>
  ugc_right: <权限代码：1为公开，4为仅好友，16为仅自己私密>
  format: json
  code_version: 1
  ```
- **成功标识**：返回 `{"code": 0, "tid": "<生成的说说ID>"}`。
- **附图**：`publish --image <本地图片>` 会先校验图片、转为最长宽度 2048 的 JPEG，再上传到 `https://up.qzone.qq.com/cgi-bin/upload/cgi_upload_image`，使用返回的图片标识组装 `richval`、`pic_bo` 等附图字段。凭据和图片 Base64 不写入日志。
- **删除**：`delete --tid <指定说说ID>` 仅操作当前登录账号的空间；不接受其他目标 QQ 参数。

---

## 三、CLI 运维工具用法

工具脚本路径：`~/.openclaw/workspace/skills/qzone-ops/scripts/qzone-cli.mjs`

```bash
# 1. 检查凭据健康度（安全脱敏输出）
node ~/.openclaw/workspace/skills/qzone-ops/scripts/qzone-cli.mjs creds [--account default|yuexia]

# 2. 获取好友/自身的动态文本与图片列表
node ~/.openclaw/workspace/skills/qzone-ops/scripts/qzone-cli.mjs msglist --target <目标QQ> --num 5 [--account default|yuexia]

# 查询当前登录账号的好友动态流（与指定 QQ 的说说列表不同）
node ~/.openclaw/workspace/skills/qzone-ops/scripts/qzone-cli.mjs feeds --count 5 [--account default|yuexia]

# 3. 为某条动态点赞（--unlike 参数为取消点赞）
node ~/.openclaw/workspace/skills/qzone-ops/scripts/qzone-cli.mjs like --target <目标QQ> --tid <说说tid> [--account default|yuexia]

# 4. 对某条动态发表评论
node ~/.openclaw/workspace/skills/qzone-ops/scripts/qzone-cli.mjs comment --host <目标QQ> --tid <说说tid> --content "评论内容" [--account default|yuexia]

# 直接回复某条原评论：原评论 ID/作者来自 commentlist[].tid/uin，不在正文艾特
node ~/.openclaw/workspace/skills/qzone-ops/scripts/qzone-cli.mjs reply --host <说说主人QQ> --tid <说说tid> --comment-id <原评论tid> --reply-uin <原评论作者QQ> --content "回复内容" [--account default|yuexia]

# 5. 自己发布一条空间说说
node ~/.openclaw/workspace/skills/qzone-ops/scripts/qzone-cli.mjs publish --content "今日动态内容" [--right 1|4|16] [--account default|yuexia]

# 发一条附图说说（必须已有用户授权）
node ~/.openclaw/workspace/skills/qzone-ops/scripts/qzone-cli.mjs publish --content "今日动态内容" --image /absolute/path/image.png --right 4

# 删除用户明确指定的自有说说
node ~/.openclaw/workspace/skills/qzone-ops/scripts/qzone-cli.mjs delete --tid <说说tid>
```

---

## 四、爱莉每日图文任务

用户已于 2026-10-16 授权完整图文发布/删除测试，以及每天北京时间 08:00–22:00 随机发布一次爱莉图文。发布账号固定为 `default/700000006`，可见范围仅好友（4）；该每日发布任务本身不包含自动评论、点赞或其他账号发布。2026-10-19 另授权的空间互动巡检见第五节。

- 固定入口：`node {baseDir}/scripts/qzone-daily.mjs prepare`，每天 06:15 由 OpenClaw command automation 调用。脚本抽取当天随机时间并创建一次性发布任务，提前准备图文。文案首选 Gemini 3.8 Flash High，回退 GPT-6 Luna、Grok 4.7，不读取聊天记忆或开放模型工具。
- 每日角色方案使用 `scripts/qzone-character-policy.json`：先独立按 50% 概率选择单人或互动。单人随机取 `/root/letu_chara_image/爱莉希雅/` 中一张参考图；互动先从有有效参考图的角色中按剧情关系创作权重选一位，再为两人各随机取一张图。空目录不会被抽中；未来新增角色按配置或默认权重参与。权重是可调创作设定，非官方数值；调整配置或排查参考图链路时读 [每日角色生成说明](references/daily-character-generation.md)。人物方案、参考图路径和 SHA-256 保存到日期状态的 `referencePlan`，失败后重新准备会重新抽取。
- 本地参考图使用 `agy-proxy-diagnose.sh local-image-generate <场景> <爱莉参考图> [同伴参考图]`，不再在线查找替代参考图。文案与场景共用固定人物方案和计划发布时间：互动文案自然提及同伴，场景明确双方身份、活动分工、动作、表情、姿态与视线。原图只作人物身份与外观参考，禁止照搬动作、表情、姿态和构图；服装按活动与时段调整。视觉复核继续核对人物数量、身份、源姿态替换与活动对应性。没有爱莉参考图时准备失败，不静默使用其他来源。
- 生图复用 `agy-proxy` 的角色参考图生成和视觉验收链：Gemini 3.8 Flash High 编排、GPT Image 2 生图。脚本自身包含重试，不在外层重复生成。只有正常验收通过或按三张最高分例外选中的 `image_output` 才进入草稿。身体结构占 70%、角色与场景占 30%，要求身体分≥90、总分≥85且无严重结构错误；不通过时在生图脚本内部携带错误最多重画 2 次。若 3 张均成功生成并评分且均不达标，按总分选最高者发布，同分取先生成者；保留不达标结论，不伪造通过。发布必须验证 `anatomy-v1` 评估凭据与图片哈希；三张最高分例外还必须核对 `best-of-three-v1` 的三张评分、哈希和排序。旧版仅有 `imageVerified` 或不足三张的低分结果不足以发布。
- `node {baseDir}/scripts/qzone-daily.mjs status` 查看当天计划和状态；`publish YYYY-MM-DD` 仅在当天已保存的计划时间到达且仍在 08:00–22:00 内执行。自动任务跨天作废，不自动补发旧图文。
- 用户已于 2026-10-19 授权准备失败后当天随机重试并私聊通知：失败后随机等待 15–60 分钟再次准备，每天最多 6 次准备（含首次），重试最晚 20:30 开始，为图片验收与 22:00 前发布留出时间；当天剩余时间不足或达到上限时停止并通知。每次重试重新选择随机发布时间；准备成功后才登记/启用发布任务，旧的失败发布任务会停用。同一日期与尝试序号绑定唯一一次性任务，重复或过期任务不会重复生成。每次生图内部仍沿用既有网络重试、质量评分与三张择优规则。
- 失败通知由爱莉通过统一持久投递队列私聊配置中的主管理员，仅含日期、阶段、安全原因摘要和下次重试时间。通知与业务重试分别记录；通知超时只使用原投递 ID 核对，不创建第二条消息，也不重发空间动态。发布结果不确定时只核对，不盲目重新准备或重新发布。
- `prepare-retry YYYY-MM-DD <2至6>` 仅由当天登记的固定任务调用，检查日期、轮次和随机到期时间。`notify-failure YYYY-MM-DD` 投递已有失败记录的通知，不生图、不发布。
- 用户另于 2026-10-19 明确授权补发 2026-10-18 未成功发布的动态。`makeup <昨天日期> <已验收图片路径>` 为显式补发入口，可在常规时段外执行，但只接受昨天原草稿、主账号、仅好友可见和有效图片质量凭据；先查同文动态，再沿用正常发布前持久化、发布后图文回读与防重逻辑。此入口不加入每日自动任务，也不授予其他日期自动补发权限。
- 状态和受限日志位于 `/root/.openclaw/state/qzone-daily/`，日期状态位于 `days/YYYY-MM-DD.json`。OS 文件锁防止并发；成功后跳过重复触发。发布前持久化状态，响应超时/进程中断时先回读核对，无法确认时停止，不盲目重发。
- 发布后核对说说 ID、文案、1 张配图，并下载图片片段验证编码与尺寸，拒绝占位图。缺图、验收失败、登录失败不降级发布纯文字。
- `e2e <已验收图片> <文案JSON>` 会发布一条仅好友可见的测试图文、回读后删除并确认消失；只在用户明确授权整条测试链时调用。`seed` 仅用于把当天已成功删除的测试草稿作为首日待发布草稿，避免重复生图；后续每天生成新图文。

## 五、每十五分钟空间互动巡检

用户于 2026-10-19 明确授权：爱莉主账号每十五分钟检查好友动态流，给所有新出现且可点赞的动态点赞，并直接回复自己说说下的新评论。本任务为固定 command automation，不开放普通访客工具，也不授予其他账号、其他空间评论、删除、转发或自动发布权限。

- 入口 `node {baseDir}/scripts/qzone-patrol.mjs run`，每小时 00/15/30/45 分执行，全天运行；`init` 首次读取成功后建立基线，已有动态与评论不批量回补；`status` 只显示处理数量与状态。默认账号固定 `default`。
- 配置 `/root/.openclaw/qzone-patrol.json` 提供总开关、账号与分页上限；同时检查统一功能策略中 qzone read/interact 和任务绑定的启用状态。暂停任一开关后停止后续点赞和回复。
- 好友动态使用 feeds3 原生游标分页，保留不同动态类型的 appid、unikey、curkey 点赞参数；排除广告与不可点赞卡片。包括主账号自己的新动态。发现的新目标进入持久待办，单轮最多 20 项且约 11 分钟预算，积压留给下一轮；写操作间隔随机 15–30 秒。分页超上限会明确失败，不把未完整抓取当作已全部处理。
- 读取自己空间的说说与 commentlist/list_3，检查一级新评论和线程中的新追评。自己的评论和回复永远不触发自动回复。每个新追评在其所属的原生评论线程内回复，不把楼中楼的局部序号当作根评论 ID，也不在正文艾特。评论被编辑不会触发第二次回复。
- 回复文案由 Gemini 3.8 Flash High 优先生成，回退 GPT-6 Luna、Grok 4.7；只传对应公开说说、该线程最近八条和当前评论，不读取 SOUL/MEMORY 或私聊、群聊记录，不给模型工具。昵称和评论按不可信聊天内容处理；禁止称陌生人为舰长、输出艾特、凭据、路径或内部说明。输出通过本地检查后才发送。
- 状态目录 `/root/.openclaw/state/qzone-patrol/` 0700、文件 0600；OS flock 防止重叠，发送前持久化意图。每条动态只点赞一次，每条新评论/追评只回复一次。点赞调用的是增加赞而非切换；未知结果先用动态的 islike 回读核对。回复沿用 reply 的原生父评论参数及回读验证；丢失回执时只核对线程，不盲目重发，已知不确定状态跨重启保留。
- 此用户授权覆盖该固定巡检的自动点赞和回复，无需对每一项再次请求审批。不要改用通用 agent 循环、临时 curl 或让模型决定任意空间写操作。

## 六、风控与安全规范

1. **写操作频率控制**：QQ 空间的 Web CGI 接口存在腾讯反垃圾风控策略，单账号单日写操作（发说说/评论/点赞）建议控制在 50 次以内。
2. **随机间隔**：Agent 自动轮询或批量操作时，应至少保留 15~60 秒的随机防抖延时。
3. **隐私脱敏**：任何输出日志禁止打印完整的 Cookie 串或 `p_skey` 敏感字段。

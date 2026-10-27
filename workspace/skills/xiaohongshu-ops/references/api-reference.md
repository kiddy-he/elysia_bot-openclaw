# 小红书接口调用参考

核对日期：2026-10-21。本文按当前 `src/schemas.js`、`src/service.js`、`src/backends/http.js`、`src/domain/api.js` 和 `src/domain/notes.js` 整理。示例中的 ID、token、游标、文件路径均为占位或合成值，不含真实凭据。

本文描述已经实现的行为；“已实测”仅指 [有限账号实测记录](live-validation.json) 中的样本。评论成功响应结构来自实现和夹具，当前尚未通过真实站点读取验收。

## 1. 入口、工具和权限

这是 Node ESM 服务库和 OpenClaw 工具适配层，不是一个已经开放的 REST API。下面的 `/api/...` 地址是服务内部请求的小红书上游路径。公网登录页面仅用于人工登录验证，不是业务 API 网关。

| OpenClaw 工具 | `operation` | 用途 |
|---|---|---|
| `xhs_search_posts` | `search` | 关键词、话题文字搜索 |
| `xhs_inspect_posts` | `inspect` | 笔记正文、作者、标签、笔记互动数 |
| `xhs_read_comments` | `comments` | 一级评论、指定根评论的回复 |
| `xhs_get_profile` | `profile` | 博主资料，可选一页发布笔记 |
| `xhs_list_images` | `list_images` | 图集中的受作用域约束的图片句柄 |
| `xhs_download_images` | `download_images` | 图片下载任务 |
| `xhs_download_video` | `download_video` | 视频下载任务 |
| `xhs_job_status` | `job_status` | 读取下载任务状态及产物 ID |
| `xhs_cancel_job` | `cancel_job` | 取消本作用域的下载任务 |
| `xhs_read_artifact` | `artifact` | 校验并读取本地产物信息 |

`status`、`login`、`importSession()` 是运维入口，没有注册成模型工具。点赞数查看是读操作；点赞、收藏、评论发布、关注、删除等平台写操作没有实现为这些工具。

所有参数 schema 均设置 `additionalProperties=false`，额外字段会产生 `invalid_request`。精确机器可读合同见 `xhs-tool-contracts.json`（项目位置为 `docs/reference/xhs-tool-contracts.json`，skill 内位置为 `references/xhs-tool-contracts.json`）。

### 1.1 服务库调用

```js
import { XhsService, createTools } from '/root/komachi-xhs-js/src/index.js';

const service = await XhsService.create({
  dataDir: '/root/komachi-xhs-js/data/xhs-public',
  backend: 'http',
  authorize: async (context, operation) => hostPolicyAllows(context, operation),
  authorizeJob: async (origin, operation) => hostPolicyAllows(origin, operation),
});
service.start(); // 由常驻宿主消费持久下载队列
try {
  const trustedContext = {
    accountId: 'xhs-default',
    scope: 'conversation:example',
    actorId: 'trusted-sender',
    requestId: 'host-issued-request',
    generation: 1,                 // 可省略
    expiresAt: Date.now() + 600000, // 可省略；提供时必须为未来时间
  };
  const result = await service.execute('search', { query: '咖啡', limit: 3 },
    trustedContext, { callId: 'call-1', signal: controller.signal });
} finally {
  await service.close();
}
```

`hostPolicyAllows` 和 `controller` 表示宿主的授权函数和 AbortController，需要宿主提供。四个身份字段不能为空且最长 256 字符；`generation` 为整数或最长 128 字符的字符串；`expiresAt` 为毫秒时间戳。不要填写 `expiresAt: 0`。

同一流程的搜索、图片句柄、游标、任务和产物引用必须保持 `accountId/scope/actorId/requestId/generation` 一致。跨请求引用会被拒绝。`callId` 只是本次工具调用的追踪 ID，不能用每次变化的 `callId` 替代稳定的请求范围。

一个 `dataDir` 对应一个实际小红书账号；`accountId` 是本地隔离信息，不会自动切换小红书账号。外部客户端不能自行指定可信上下文。默认授权回调允许调用，仅适用于本机可信宿主；生产渠道必须接入真实授权和撤权处理。

### 1.2 统一返回与包装

```json
{
  "version": 1,
  "call_id": "call-1",
  "operation": "search",
  "ok": true,
  "status": "ok",
  "data": {},
  "error": null
}
```

| 字段 | 说明 |
|---|---|
| `version` | 合同版本，目前为 1 |
| `call_id` | 宿主传入的调用 ID，缺省生成 UUID |
| `operation` | 本地操作名 |
| `ok` | 本次服务调用是否成功；不等价于下载任务是否成功 |
| `status` | `ok`、`accepted`、`failed` 或 `cancelled` |
| `data` | 本接口数据；失败时为 `null` |
| `error` | 成功时为 `null`；失败时包含稳定 `code` 及有限附加字段 |

OpenClaw 的 `execute(callId, params, signal)` 包装返回：

```js
{
  content: [{ type: 'text', text: JSON.stringify(result) }],
  details: result,
  isError: !result.ok,
}
```

### 1.3 URL、计数和时间

笔记可传 HTTPS `www.xiaohongshu.com` / `xiaohongshu.com` 下的 `/explore/<24位小写hex ID>`、`/discovery/item/<ID>`，或受限解析的 `xhslink.com` 短链接。`ref_id` 传完整链接，不是裸 ID。保留搜索结果中的 `source_url` 与 `xsec_token`，不猜 token，不删除 token 后反复试请求。

笔记 `metrics` 的四个槽位固定为 `likes/collects/comments/shares`。每个槽位可能为 `null`，或：

```json
{"value": 1138, "raw": "1138", "approximate": false}
```

无法解析为安全非负整数的文本，例如 `1.2万`，表示为：

```json
{"value": null, "raw": "1.2万", "approximate": true}
```

不要把缺失当 0，不要把缩写推算成精确值。**评论 `like_count/sub_comment_count` 当前是整数或 `null`；作者笔记 `metrics` 当前是含 `likedCount` 等别名的上游对象；两者不采用上述笔记详情计数结构。**

详情 `published_at` 为站点毫秒时间转换的 ISO 字符串，无法确定为 `null`。搜索结果始终不承诺日期。`observed_at` 是本次采集时刻，不是发布时间。

## 2. 搜索：`xhs_search_posts` / `search`

| 参数 | 必填 | 类型与范围 | 默认/语义 |
|---|---|---|---|
| `query` | 是 | 非空字符串，最长 120 | 去首尾空白，当前实现去掉开头 `#` |
| `limit` | 否 | 整数 1–12 | 6；限制输出候选条数 |
| `sort` | 否 | `relevance` / `latest` | `relevance` |
| `media_type` | 否 | `image` / `video` | 不限制类型 |
| `search_mode` | 否 | `keyword` / `tag` | `keyword` |

```json
{"query":"咖啡","limit":3,"sort":"latest","media_type":"image","search_mode":"keyword"}
```

返回字段：`posts[]`、`visible_posts`、`coverage=visible_candidates_only`、`date_status=unknown`、`search_visibility`、`search_mode`、`query`、`semantic_note`。缓存命中增加 `cached: true`。

每个候选含 `post_id/source_url/title/author/author_id/note_type/published_at/metrics/tags/identity_status/media_roles`。`identity_status=candidate`，`media_roles` 当前为空数组，需详情核对。空结果是“未观察到候选”，不证明站点无相关笔记。

上游：`POST https://edith.xiaohongshu.com/api/sns/web/v1/search/notes`，内部 payload：

```json
{
  "keyword":"咖啡", "page":1, "page_size":20,
  "search_id":"<generated>", "sort":"time_descending", "note_type":2,
  "ext_flags":[], "image_formats":["jpg","webp","avif"]
}
```

映射：相关排序为 `general`，最新为 `time_descending`；图文 `note_type=2`，视频 1，不限 0。**只读取第一页，没有公开搜索 cursor/page 参数。**

tag 示例：`{"query":"#咖啡","search_mode":"tag"}`。当前使用相同关键词端点，并返回：

```json
{"semantic_note":"tag mode uses the site keyword search endpoint; exact topic-only filtering is not independently verified"}
```

不要称其为严格 topic ID 过滤，也不保证全量话题笔记。需要核对标签时读取详情的 `tags`，不要把候选排序视作标签归属证据。

同一请求范围默认最多 4 次未缓存搜索，超限 `search_request_budget`；新排序/筛选组合也计入。缓存不是实时刷新入口。

## 3. 笔记浏览：`xhs_inspect_posts` / `inspect`

| 参数 | 必填 | 类型与范围 |
|---|---|---|
| `ref_ids` | 是 | 1–6 个唯一 URL 字符串，每项最长 2000 |

```json
{"ref_ids":["https://www.xiaohongshu.com/explore/0123456789abcdef01234567?xsec_token=synthetic"]}
```

返回 `resources[]` 和 `partial`。成功资源含：

- `post_id`、`source_url`、`title`（最多 240 字符）、`text`（最多 20000 字符）。
- `author`、`author_id`、`note_type=normal|video`、`published_at`。
- `metrics`、`tags[]`（最多 50 个 `id/name/type`）、`media_count`。
- `identity_status=matched`、`date_status=source_reported|unknown`、`publicity_status=not_independently_verified`、`trust=untrusted_external_sources`、`status=ok`。

这里只返回媒体数量，图片尺寸由 `list_images` 提供，视频流选择元数据在下载内部处理。身份复核匹配不等价于独立证明笔记公开可见。

失败资源含 `source_url/status=failed/error`；全部失败时外层 `ok=false`，细节可在 `error.resources` 中。部分成功时也必须检查 `partial`，不要漏报失败项。

上游：`POST /api/sns/web/v1/feed`：

```json
{
  "source_note_id":"0123456789abcdef01234567",
  "image_formats":["jpg","webp","avif"],
  "extra":{"need_body_topic":"1"},
  "xsec_source":"pc_feed", "xsec_token":"synthetic"
}
```

服务核对响应笔记 ID、类型和作者身份字段。无会话时允许受限公开 HTML 状态解析；已有认证会话遭拒绝不会自动降级绕过。详情按本请求缓存，缺省存储 TTL 为 24 小时，互动数字表示观察到的缓存快照，不承诺每次刷新。

## 4. 评论区：`xhs_read_comments` / `comments`

| 参数 | 必填 | 类型与范围 | 说明 |
|---|---|---|---|
| `ref_id` | 是 | URL，最长 2000 | 从详情定位原笔记 |
| `limit` | 否 | 整数 1–50 | 默认 20，输出条数上限 |
| `cursor` | 否 | 字符串，最长 512 | 首页省略；后续传本地 `next_cursor` |
| `parent_comment_id` | 否 | 非空字符串，最长 128 | 省略为一级评论；提供为根评论回复页 |

```json
{"ref_id":"https://www.xiaohongshu.com/explore/0123456789abcdef01234567?xsec_token=synthetic","limit":20}
```

回复页传上一页已观察到的根 `comment_id`，不要将笔记 ID 或随意猜测的 ID 作为父评论。

返回示意（结构示例，非已验收的真实站点响应）：

```json
{
  "post_id":"0123456789abcdef01234567", "source_url":"<canonical note url>",
  "parent_comment_id":null,
  "comments":[{
    "comment_id":"comment-example", "parent_id":null, "content":"示例评论",
    "created_at":"2026-10-21T00:00:00.000Z",
    "user":{"user_id":"user-example","nickname":"示例用户","avatar_url":null},
    "like_count":12, "sub_comment_count":3, "sub_comments":[]
  }],
  "next_cursor":"cur-example", "has_more":true,
  "observed_at":"2026-10-21T00:00:00.000Z", "trust":"untrusted_external_sources"
}
```

`sub_comments` 是内嵌预览，不证明回复完整。当前每层预览最多保留 20 项。评论内容最多 10000 字符，用户/计数可能缺失；`null` 不代表 0。

上游（字段为当前实现，与网页 JS 的驼峰请求约定对应；成功取数仍待实测）：

| 页类型 | 方法和路径 | 查询字段 |
|---|---|---|
| 一级 | `GET /api/sns/web/v2/comment/page` | `noteId/cursor/topCommentId/num/imageFormats/xsecToken` |
| 二级 | `GET /api/sns/web/v2/comment/sub/page` | 上述字段及 `rootCommentId` |

`topCommentId` 当前为空；`rootCommentId=parent_comment_id`；`imageFormats=jpg,webp,avif`；`xsecToken` 从笔记 URL 获得。

cursor 被保存在私有 SQLite 中，用本地 `cur-...` 随机句柄替代站点游标，绑定身份范围、笔记 ID 和根评论 ID。跨笔记、跨根评论、过期或跨身份使用返回 `invalid_cursor`。

**实测状态：HTTP 461，返回 `challenge_required`。一级/二级成功分页没有真实站点验收。** 不应把这个错误解释为“没有评论”，也不能保证重新登录一定解除该接口的挑战。

## 5. 博主资料：`xhs_get_profile` / `profile`

| 参数 | 必填 | 类型与范围 | 说明 |
|---|---|---|---|
| `user_id` | 是 | 非空字符串，最长 128 | 取自笔记 `author_id`；通常为站点用户 ID，schema 未强制 hex |
| `include_posts` | 否 | 布尔值 | 默认不附加作者笔记 |
| `posts_limit` | 否 | 整数 1–20 | 附加页默认 10 |
| `posts_cursor` | 否 | 字符串，最长 512 | 后续页传 `posts_next_cursor`，同时设 `include_posts=true` |

```json
{"user_id":"0123456789abcdef01234567","include_posts":true,"posts_limit":10}
```

资料字段：

| 字段 | 当前含义/类型 |
|---|---|
| `user_id` | 本次请求的目标 ID；上游不返回该 ID 时不能据此声称独立身份验证 |
| `nickname/red_id/bio` | 字符串；缺失可为空字符串 |
| `avatar_url` | HTTPS URL 或 `null`；仅元数据，不是已下载产物 |
| `gender` | 站点整数枚举或 `null`；当前不解释枚举含义 |
| `ip_location` | 站点报告的地区文本，不等于当前位置 |
| `stats.posted/liked/collected` | 当前站点顶层字段映射，安全非负整数或 `null` |
| `tags[]` | 当前支持的 `id/name/type` 映射；并非保证作者所有标签均可映射 |
| `visibility` | 上游 `tab_public` 对象或 `null`；不是独立隐私授权结论 |
| `observed_at/trust` | 本次观察时刻与不可信外部来源标记 |

没有规范化的粉丝数、关注数输出。不要把 `stats.liked/collected` 直接称作粉丝数，也不要自行承诺其业务语义；它们是站点原字段的数字。

上游资料：`GET /api/sns/web/v1/user/otherinfo?target_user_id=<ID>`。注意是 **`target_user_id`**，不是 `userId` 或 `targetUserId`。

设置 `include_posts=true` 时追加：`GET /api/sns/web/v1/user_posted`，查询 `user_id/cursor/num`。当前不用 v2 路径，历史探测 v2 返回 404。

附加返回：`posts[]`、`posts_next_cursor`、`posts_has_more`。每篇作者笔记包含 `post_id/source_url/title/note_type/author/author_id/published_at/metrics/cover_url`。缺少上游 token 时 `source_url` 可能为 `null`，不要为此伪造 URL 凭据。其 `metrics` 当前是上游计数对象加驼峰别名（如 `likedCount`），进一步标准化的互动数据请调用 `inspect`。

后续页 `posts_cursor` 绑定当前身份和 `user_id`。当前 `include_posts` 的第二个请求失败会令整个 profile 调用失败，不保证先返回已取得的资料。

## 6. 分页边界

- 搜索：只读站点第一页，无继续页参数。
- 图片：本地 `offset/next_offset`，针对当前笔记候选图集。
- 评论：`next_cursor` 绑定笔记与根评论。
- 博主笔记：`posts_next_cursor` 绑定博主。
- 所有 cursor 的可用期受存储 TTL 约束；默认 24 小时，不支持跨 scope 恢复。

当前评论和博主笔记会将站点整页结果按 `limit/posts_limit` 截断，继续游标来自整页末尾。若站点未遵守请求数量，较小 limit 可能跳过被截断的余项。**当前分页不能作为无遗漏全量导出的保证。** 通常用评论默认 20、博主笔记 20，并在回答中说明仅覆盖可见分页样本；仍不承诺全量。

## 7. 图片列表：`xhs_list_images` / `list_images`

| 参数 | 必填 | 类型与范围 |
|---|---|---|
| `ref_id` | 是 | 笔记 URL，最长 2000 |
| `offset` | 否 | 整数 0–159，默认 0 |

```json
{"ref_id":"https://www.xiaohongshu.com/explore/0123456789abcdef01234567?xsec_token=synthetic","offset":0}
```

返回中包含笔记规范化字段及：

```json
{
  "images":[{
    "image_id":"img-example", "media_index":0, "role":"post_image",
    "quality":"source_served", "width":1200, "height":1600
  }],
  "total":1, "next_offset":null, "declared_image_count":1,
  "candidate_limit_reached":false
}
```

每页最多 20 项，最多扫描 160 张。`media_index` 对应站点图集位置；尺寸缺失时可为 0；去重或无效 URL 会令 `total` 与站点声明数不同。

`image_id` 绑定当前身份范围，内部 CDN URL 留在私有存储。只适用于图文；视频笔记返回 `video_has_no_album`。无可用图片返回 `note_no_images`。

## 8. 图片下载：`xhs_download_images` / `download_images`

| 参数 | 必填 | 类型与范围 |
|---|---|---|
| `image_ids` | 是 | 1–20 个唯一非空字符串，每项最长 64；来自 `list_images` |
| `quality` | 否 | `best_available`（默认）/ `original_only` |
| `constraints` | 否 | 见下表 |

| `constraints` 字段 | 类型 | 校验 |
|---|---|---|
| `author_id` | 非空字符串，最长 128 | 必须与已核对的笔记作者一致 |
| `published_after` | 日期字符串，最长 80 | 包含下界；必须能核对笔记日期 |
| `published_before` | 日期字符串，最长 80 | 不包含上界；与 after 同时给出时必须更晚 |

```json
{
  "image_ids":["img-example"], "quality":"best_available",
  "constraints":{"published_after":"2026-01-01T00:00:00Z","published_before":"2027-01-01T00:00:00Z"}
}
```

日期要求不能证明时返回 `resource_freshness_unverified`；作者不符为 `publisher_unverified`。先验证句柄与约束，再排队，执行时再次校验。

返回任务对象，外层通常 `status=accepted`。每张图片最多 8 MiB；每任务图片传输预算 32 MiB，失败传输也计预算。支持 sharp 校验的 JPEG/PNG/WebP/AVIF，解码像素上限 16000000，不保证原始上传文件质量。`original_only` 返回 `original_quality_unverified`，不会静默降级。

## 9. 视频下载：`xhs_download_video` / `download_video`

| 参数 | 必填 | 类型与范围 |
|---|---|---|
| `ref_id` | 是 | 笔记 URL，最长 2000 |
| `quality` | 否 | 同图片下载 |
| `constraints` | 否 | 同图片下载 |

```json
{"ref_id":"https://www.xiaohongshu.com/explore/0123456789abcdef01234567?xsec_token=synthetic","quality":"best_available"}
```

详情中选择非 DRM 的 MP4/H.264 原生流，不处理 DRM 或 HLS。时长最多 1200 秒，单文件最多 128 MiB，最多选 3 个兼容版本并使用有限备份 URL；总传输预算 256 MiB/48 次。版本按分辨率、码率排序，产物 `quality` 为 `highest_native/lower_native`，可能有 `fallback_reason`。

ffprobe 核对 MP4 容器、视频 H.264、音轨数量/编码/时长/像素，ffmpeg 解码首帧验收；这不是对每一帧完整解码。文件保留 SHA-256，可能因兼容性或大小超限返回 `no_compatible_video`。

2026-10-21 已有一次真实视频下载成功的脱敏记录，产物 5161155 字节；该记录不代表任意视频均可下载。

## 10. 查询任务：`xhs_job_status` / `job_status`

参数 `job_id` 必填，非空字符串最长 64。

```json
{"job_id":"job-example"}
```

```json
{
  "job_id":"job-example", "state":"succeeded", "operation":"download_images",
  "result":{
    "artifacts":[{"artifact_id":"art-example","kind":"image","bytes":157120,"sha256":"<hash>","delivery_status":"not_sent"}],
    "failures":[], "delivery_status":"not_sent"
  },
  "error":null,
  "created_at":"2026-10-21T00:00:00.000Z", "expires_at":"2026-10-22T00:00:00.000Z"
}
```

| `state` | 含义 |
|---|---|
| `queued` | 已持久排队，等待运行器 |
| `running` | 已认领执行，尚未完成 |
| `succeeded` | 全部完成，可读取 artifacts |
| `partial` | 部分图片成功，需检查 failures |
| `failed` | 下载失败，读取 job 的 error/result |
| `cancelled` | 已取消或撤权 |
| `expired` | 尚未执行就到期 |

外层 `ok=true` 可能只是成功查询到一个 `state=failed` 的任务。必须同时检查 `data.state` 和 `data.error/result.failures`。跨 scope/到期为 `job_unavailable`。

轮询可先等 1–2 秒，再拉长间隔；设置宿主等待上限，不使用无界等待。查询不会自动执行队列：插件服务启动 `service.start()` 消费；CLI 单次调用需要运维运行 `--run-pending`。

## 11. 取消任务：`xhs_cancel_job` / `cancel_job`

参数与查询相同：`{"job_id":"job-example"}`。

仅取消当前范围中 `queued/running` 的任务，返回当前任务对象；已经完成的任务保持现状。取消记录参与去重，重复提交相同下载不会自动复活为新任务。取消本地下载不发送任何小红书平台写请求。

## 12. 读取产物：`xhs_read_artifact` / `artifact`

参数 `artifact_id` 必填，非空字符串最长 64：

```json
{"artifact_id":"art-example"}
```

产物通用字段：`artifact_id/kind/bytes/mime_type/width/height/sha256/post/created_at/delivery_status`。图片还包括 `format/media_index/quality`；视频有 `duration_seconds/codec/quality/fallback_reason`。读取后增加：

```json
{"path":"/private-data/media/art-example.bin","lease_until":"2026-10-21T00:20:00.000Z"}
```

读取时核对常规文件、非符号链接、长度和 SHA-256。磁盘扩展名当前为 `.bin`，应按返回 MIME/format 命名或投递。`path` 是给可信宿主的本地文件位置，不能当公网下载链接；不要在聊天中泄露内部绝对路径。

每次读取设置约 20 分钟租约供清理保护；租约不是对外授权，也不重置条目的数据库过期时间。默认产物 TTL 24 小时，缓存配额 512 MiB。过期/跨 scope 为 `artifact_unavailable`，文件变化为 `artifact_integrity_failed`。

`delivery_status=not_sent` 表示只完成本地下载。QQ、其他渠道或 OpenClaw 附件发送需要另外经过宿主投递权限和投递回执；不得宣称工具已发送文件。

## 13. 运维入口与生命周期

### 13.1 `status`

参数 `{}`，要求 `context.operator=true`。HTTP 请求 `GET /api/sns/web/v2/user/me`，必须为非游客且有用户 ID 才算已认证。返回 `configured/authenticated/backend/verification/login_method`，不返回凭据。`configured=true` 只说明有会话配置。

### 13.2 `login`

参数 `{}`，要求 operator；默认 HTTP 二维码状态机；`backend=interactive` 时为临时浏览器人工扫码/验证，成功保存后再以 HTTP `user/me` 核对。`backend=browser` 用浏览器业务后端，新增 comments/profile 不保证支持。

二维码、临时互动链接是运维凭据，不能写入公开文档。现部署公网基础入口为 `https://login.example.invalid:39081`；需由运维启动任务生成当次私有链接，基础地址本身不代表已有可用任务。现登录脚本位于 `deploy/xhs-login/login-public.sh`。无新登录需求时复用已有会话，不在查询技能中自动启动登录。

### 13.3 CLI、会话导入与队列

本地 operator CLI 入口：`node /root/komachi-xhs-js/src/cli.js --data-dir <private-dir> --backend http`，stdin 一个 JSON 对象 `{operation,params,context}`，上限 8 KiB。命令失败退出码 1；stdout 为 JSON（login 可有进度事件），不要用终端输出作为凭据导出通道。

`--import-session <private-file>` 导入授权者提供的会话；`--run-pending` 消费持久下载队列；`service.importSession(session, operatorContext)` 是相同的库级导入入口。普通用户/模型不得自行构造 operator 上下文绕过渠道授权。

`service.start({intervalMs:1000})` 启动调度；`runPending({signal})` 显式消费；`revoke(context)` 撤销本请求范围并取消相关任务；`close()` 停止调度，取消在途工作，等待收尾后关闭存储。

默认前台业务截止 85 秒，后台任务 180 秒，HTTP API 单次 25 秒，JSON 响应 2 MiB 上限。上游连接直接访问小红书，不继承本机代理；固定公网 DNS/IP 与 SNI、禁止凭据重定向、响应大小和签名 URL 一致性检查在 HTTP 后端内完成。

## 14. 错误处理

| 错误码 | 解释及建议 |
|---|---|
| `invalid_request/invalid_operation` | 参数不符 schema/不存在的操作，按合同修正 |
| `trusted_context_required/operator_required` | 缺少可信身份或不允许调用运维接口，交宿主处理 |
| `authorization_expired/authorization_revoked` | 权限失效/撤回，停止，不换身份重试 |
| `login_required/session_invalid` | 会话缺失/不可用，交运维人工登录 |
| `challenge_required` | 406/461/471 等站点验证，停止当前请求，不能当空结果 |
| `rate_limited` | 限流，停止；运维决定冷却策略 |
| `permission_denied/network_restricted` | 账号权限或网络拒绝，不自动换账号/代理 |
| `crawler_busy` | 同一账号正在执行其他受锁请求；安排稍后执行，不并发抢锁 |
| `invalid_cursor` | 原游标过期/跨身份或资源，确认需求后重读第一页 |
| `candidate_unavailable/job_unavailable/artifact_unavailable` | 句柄不可见或过期，不能伪造新句柄 |
| `capability_unavailable` | 选定后端未实现该能力 |
| `search_request_budget/request_expired` | 本请求搜索预算/有效期耗尽，交宿主处理生命周期 |
| `note_unavailable/identity_mismatch` | 详情不可用或目标不匹配，不输出错误笔记作为目标 |
| `note_no_images/video_has_no_album/note_has_no_video` | 媒体类型不符，不把封面当原图集或视频 |
| `original_quality_unverified` | 无法证明原始上传质量，按用户需求选择是否接受 best_available |
| `protected_stream/no_compatible_video` | 受保护或没有受支持的视频版本 |
| `media_cache_full/*_size_limit/transfer_budget_exhausted` | 缓存、文件或传输预算到限，减少本次下载范围 |
| `artifact_integrity_failed` | 产物校验失败，不能交付；交运维检查后清理/恢复 |
| `cancelled/deadline_exceeded` | 取消/超时；下载先查原任务再决定下一步 |

terminal 集合为 `network_restricted/login_required/session_invalid/challenge_required/rate_limited/permission_denied`，在同一请求范围持久停止后续站点操作。新 requestId 不等于解除账号限制。不要在技能中通过反复换 requestId 绕过 terminal。撤权优先级最高。

## 15. 推荐工作流与当前验收范围

| 用户需求 | 调用顺序 |
|---|---|
| 查某个话题的笔记 | search(tag) → inspect → 核对 tags，说明搜索语义和样本范围 |
| 浏览文章及查看点赞数 | search（已有 URL 可省略）→ inspect → 读取 text/metrics |
| 阅读评论和回复 | inspect → comments → 用真实根 ID 查回复；仅按需求翻有限页 |
| 查看博主 | inspect 取 author_id → profile；需要作者笔记才 include_posts |
| 下载图片 | list_images → download_images → job_status → artifact |
| 下载视频 | download_video → job_status → artifact |

已验证：有限搜索/详情/图片、博主资料和笔记、兼容视频下载。评论遇到 461，tag 精确过滤未验证，粉丝数未规范化，全量/无遗漏分页导出不作保证。

当前 OpenClaw 桥接目录 `openclaw-plugin/` 已有本地注册合同测试；运行配置中尚未启用该插件，不能把合同测试解释成运行网关已经暴露工具。skill 是使用说明，不会自行安装或授权插件。部署时需核对当前 SDK、真实 actor/授权映射、稳定请求范围及生命周期：桥接缺少 sessionKey 时有 fallback，且使用 sessionKey 作 requestId 的默认策略会让 4 次搜索预算和 terminal 持续作用于同一会话。正式多用户服务应由宿主明确绑定 actor、请求期限、撤权与预算，不根据模型输入推断授权。

## 16. 底层 HTTPS 与签名调用规则

这些规则由 `HttpBackend` 处理，skill 和模型不接收原始凭据：

1. 从私有会话存储加载与 URL 域名/路径/有效期匹配的 Cookie。业务请求要求 `a1` 与 `web_session`，`userAgent/b1/webSsk` 随会话保持一致。
2. GET 使用共享的查询串编码器生成实际 URL，再用对应 GET 签名路径；POST 按同一 payload 签名和发送。不能让签名目标与线上请求 URL 不同。
3. 由 `ApiSigner` 和会话签名状态生成有限请求头：`x-s/x-s-common/x-t/x-b3-traceid/x-xray-traceid`，搜索与 feed 另外启用 RAP 参数。不要在日志或 skill 示例中输出这些值。
4. API 业务 origin 固定 `https://edith.xiaohongshu.com`；直接解析公网地址后固定连接 IP，保留目标主机的 TLS SNI 和 Host；带凭据请求不跟随重定向。
5. 非 200 HTTP、超大/不支持编码的响应、非 JSON、`success!==true` 或 `code!==0` 都视作失败。不会将 461 页面或“请登录”的业务响应解释为成功空列表。
6. 合法 `Set-Cookie` 按作用域合并并私有保存，不返回给模型。请求取消和授权检查贯穿数据提交。

完整登录 HTTPS 顺序、SSK/二维码状态机和原版对比已有单独记录：项目 `docs/HTTP_API_WORKFLOW.md`、`docs/LOGIN_COMPARISON.md`、`docs/INTERACTIVE_LOGIN.md`。业务 agent 只需按本说明使用工具；运维应先阅读对应登录文档，而不是复制签名值发请求。

# 常用工作流

以下为工具参数示例。所有 `synthetic`、`img-example`、`job-example`、`art-example`、`cur-example` 都是结构示例，实际调用必须使用本次工具返回的 URL/句柄。可信身份范围由宿主维持，不能由 agent 参数指定。

## 搜索、浏览、比较互动数

1. `xhs_search_posts`：

```json
{"query":"咖啡","limit":6,"sort":"latest","media_type":"image","search_mode":"keyword"}
```

2. 从结果选择用户关心的笔记，最多 6 篇一起 `xhs_inspect_posts`：

```json
{"ref_ids":["https://www.xiaohongshu.com/explore/0123456789abcdef01234567?xsec_token=synthetic"]}
```

3. 检查每篇 `status` 和外层 `partial`。从 `text` 总结正文，从 `metrics.likes/collects/comments/shares` 取计数。引用来源链接，缺日期或缺计数时明确说明。当前详情可能来自同请求缓存，不能承诺实时数字。

用户提供已有链接时从第 2 步开始。用户只要求阅读时不自动下载图集。

## 话题文字检索

```json
{"query":"#我的咖啡日记","limit":6,"search_mode":"tag"}
```

该模式复用关键词端点，实际不接受 topic_id，也没有搜索继续页。需精确判断是否标了某话题时，再 inspect 核对 tags；详情没有该标签时不能声称已匹配。

## 评论与根评论回复

一级评论：

```json
{"ref_id":"https://www.xiaohongshu.com/explore/0123456789abcdef01234567?xsec_token=synthetic","limit":20}
```

只在用户需要更多时把上次 `next_cursor` 放入 `cursor`，保持相同笔记和同一宿主请求范围。回复页增加真实根 `comment_id`：

```json
{"ref_id":"https://www.xiaohongshu.com/explore/0123456789abcdef01234567?xsec_token=synthetic","parent_comment_id":"observed-root-comment-id","limit":20}
```

成功响应仍只代表所读页；内嵌 sub_comments 是预览。当前现场曾返回 461 `challenge_required`：若本次也返回，立即停止并说明验证阻止读取，不能推断没有评论。

## 博主与博主笔记

取自笔记详情的 `author_id`：

```json
{"user_id":"0123456789abcdef01234567"}
```

只有用户需要作者已发布笔记时才用：

```json
{"user_id":"0123456789abcdef01234567","include_posts":true,"posts_limit":20}
```

后续页原样放入 `posts_cursor` 并保持 include_posts。stats 当前不提供粉丝数/关注数，不能把 liked 或 collected 错作这些指标。作者笔记互动字段与 inspect 不同，比较点赞数时对选定笔记继续 inspect。

## 下载图集

1. `xhs_list_images` 传 ref_id；按需要用 next_offset 翻图集。
2. 选择已返回的 image_id（单次最多 20 个）。
3. `xhs_download_images`：

```json
{"image_ids":["img-example"],"quality":"best_available"}
```

4. 保留 job_id，用 `xhs_job_status` 查询，间隔从 1–2 秒开始逐步增加，设置有限等待上限。
5. `succeeded/partial` 时查看 result.artifacts 和 failures；用 artifact_id 调 `xhs_read_artifact`。
6. OneBot 接入中 read_artifact 只暂存，不发送。全部所需图片和视频暂存后调用 `xhs_send_media`（`{}`）一次，合并发送至当前 admin 私聊。只有 delivery_status=delivered 且有 receipt 才确认送达；回复文字单独发送，不另用 MEDIA/message 重复发送。其他宿主通过其授权附件接口交付，不能把内部 path 当作公网链接。

需要停止排队任务时 `xhs_cancel_job` 传原 job_id。重复提交被取消的同参数任务可能返回同一 cancelled 任务，不假装重试成功。

## 下载视频

```json
{"ref_id":"https://www.xiaohongshu.com/explore/0123456789abcdef01234567?xsec_token=synthetic","quality":"best_available"}
```

后续使用与图片相同的 job/artifact 流程。只支持兼容原生 MP4/H.264；`original_only` 会因无法证明原始上传质量而拒绝。不要承诺任意视频或原始无损版本。

2026-10-21：XHS内容工具对所有用户及当前接入群聊开放；发送仅回当前会话。每帖节点为【帖子标题】加完整图集/视频，总结单独发送。并发工具调用会按FIFO排队，最多64个等待项；等待计入工具超时，取消或撤权不执行。资源不得跨用户或跨会话复用。登录/换号/凭据/配置维护不开放给普通用户；本工具集没有平台互动写接口。

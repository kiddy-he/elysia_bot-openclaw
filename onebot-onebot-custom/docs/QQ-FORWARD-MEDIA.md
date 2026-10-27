# QQ 合并消息与小红书媒体回传（2026-10-21）

子代理 qq_forward_analysis 只读检查了运行中的 LLBot 8.1.6 镜像源码映射：SendForwardMsg.ts、transform/message/outgoing.ts、messageBuilding.ts、entities.ts。专用 API 为 send_private_forward_msg / send_group_forward_msg；普通 send_msg 不接受 node。OneBot 当前对已授权用户私聊与群聊的小红书媒体开放这一投递方式。

请求的 messages 数组中每一项为 node；其 data.user_id / nickname 使用机器人实际身份，content 为标题 text 段及 image/video 段数组。一个图片帖的全部图片按原始顺序放在同一 node.content 中，不同帖子独立 node，整轮只调用一次合并发送 API。视频帖使用原生 video 段。每个节点格式为 `【帖子标题】+该帖全部图片/视频`；标题来自已校验产物关联的帖子元数据，以普通文本段发送，去除控制字符并限制240字，无标题时显示“小红书帖子”。文字总结走普通文本发送。

LLBot 返回 data.message_id 和 data.forward_id；前者才是 QQ 投递回执，后者是合并资源句柄。当前 LLBot 的自定义顶层 source/news/summary/prompt 未传递至转换器，不能保证自定义卡片标题显示。容器通过已有共享卷读取媒体，沿用 resolveNapCatMediaUri 映射，不能直接传宿主机 /root 路径。

下载与投递依次经过：

1. xhs_list_images 获取已观察图片句柄。
2. xhs_download_images 以这些句柄选择帖子，执行器自动扩展成帖子完整图集；可覆盖 list_images 后续页，输入仍最多20个句柄，展开后整批最多160个媒体。
3. 下载记录 album_total 和 media_index。xhs_read_artifact 校验该帖完整性后，将该帖全部图片登记到当前入站消息的批次；不立刻发送。
4. xhs_send_media 重新核验来源、所有权、完整性和权限，按 post_id 分组、media_index 排序，写入持久队列的一个 forward part；网关在最终文字回复前也会检查待发批次。
5. native sendPayload 从持久队列读取可信媒体节点，发送并记录 message_id；后续调用只读取同一个投递记录。发送失败或状态不明时不转为逐张补发。

限制为每文件25MiB、单批最多64个帖子节点/160个媒体/100MiB。完整图集缺张、包含不可获取图片、超过上限时报告错误，不能偷偷只发其中一张。合并 API 等待120秒，工具配置180秒；普通 API 继续使用其原超时。下载任务状态不是 QQ 投递回执。

持久队列递归保存节点内媒体路径；GC 保护未完成投递的嵌套文件引用。收件人由可信入站身份固定，模型无目标用户、路径、任意节点文字或艾特参数；节点仅新增受限的 title 字段，由执行器取自帖子元数据。所有用户在当前已接入群聊或私聊均可调用；仅投递回实际入站会话，群聊资源同时绑定发起用户。

并发修复：XHS前台工具在同一登录态下使用FIFO等待，含两个机器人角色；不会因并发list_images直接失败。最多64个等待项，等待计入工具超时，并支持取消与出队后重新授权。

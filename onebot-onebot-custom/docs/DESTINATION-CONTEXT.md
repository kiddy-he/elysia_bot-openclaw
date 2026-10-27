# 定时任务与聊天上下文互通

同一个目标会话共享已经实际出现的文字消息：普通聊天为定时生成提供背景，已成功投递的定时提醒也为后续聊天提供背景。`src/src/destination-context.js` 统一保存与读取这些记录。

## 隔离与输入来源

- 群聊按群号和对话模式分区，允许群内配置的不同角色参考该群公开内容。不会复制、合并各成员的工具会话。
- 私聊按机器人账号、对象 QQ 和对话模式分区。私聊内容不进入群聊、其他对象或其他机器人账号的提示词。
- 入站记录来自通过入口校验的 OneBot 消息；出站记录来自实际发送成功并带 QQ message_id 的文字分片。错误、待批准和不确定投递不记作已送达。
- 已送达的普通聊天最终回复也会通过会话提交路径补记，依照 QQ message_id 去重。
- 定时任务目标来自已注册服务、启用的自动任务绑定和核心数据库当前 cron 投递配置，数据库只读访问。任务文本及模型参数不能自行指定读取对象。
- 私聊/群聊 `/new`、`/fresh` 成功后建立该账号在该目标与模式的历史读取边界，旧历史补录不能使重置前内容重新出现。

## 提示词与 fallback

普通聊天在入站时固定一份目标会话快照，与已有的会话实录/摘要一起组成 `sharedConversationText`，同时提供给主模型和 fallback。保留各成员独立 session、工具执行与并发处理。

定时 `agentTurn` 在 `before_prompt_build` 中获得当前目标快照；同次运行的重复提示词构建使用同一窗口。仅现有服务注册和实际 onebot announce 投递匹配的任务获得上下文；不扩大任何工具权限。

历史使用 JSON 行引用，并明确标识为不可信、只读背景；历史消息不能变为当前任务或授权。实时任务事实与当前指令优先。

用户创建的字面提醒仍按已登记内容发送，不调用 LLM 改写；发送成功后可被后续聊天参考。无 LLM 的命令型任务没有新的生成提示词，其实际投递到 QQ 的文字仍进入记录。

## 保留与初始化

文件：`state/onebot-destination-context.sqlite`，权限 0600。每个目标/模式保存最近最多 1000 条、7 天；注入最多 60 条、12000 UTF-8 字节。原有单人实录窗口保持原规则，新增窗口具有独立上限。

首次使用时，可从当前已注册、目标和模式精确匹配的会话导入带 clean input 元数据的用户原文以及有 delivery receipt 的角色回复，排除工具、内部原始输入和未发送候选。不会导入旧 grok 工作区。

正常模式且没有任何已记录模式切换的目标，可以通过 OneBot 只读历史接口补录近期实际文字；请求上限 4 秒。存在模式切换记录时，无法安全判断旧 QQ 消息属于何种模式，跳过 QQ 原始历史补录，使用已隔离的会话实录与后续新消息。

## 验证

- `node --test tests/destination-context.test.mjs`：群/私聊双向记录、隔离、回执去重、字节上限、过期、重启、重置、可信目标及会话导入。
- `SIMULATION_FILTER='destination-context-private-group-scheduled-bidirectional|conversation-context-primary-fallback-primary' node scripts/simulate-conversations.mjs <独立 simulation-目录>`：运行真实 OpenClaw gateway、cron 与入站链路，QQ 与模型均为本地模拟。
- `node scripts/accept-destination-context.mjs <simulation-目录>`：检查私聊/群聊双向注入和回执持久化。
- `node scripts/accept-conversation-context.mjs <simulation-目录>`：核对主模型和 fallback 的共同窗口完全相同。

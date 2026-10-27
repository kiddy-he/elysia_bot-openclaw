---
name: agy-proxy
description: 使用并排查本机图片生成与 agy/Antigravity Manager，包括 AI 生图（默认走 gpt-image-2 专用 API 提供商）、文生图、以图生图、调用 Images/Responses API、生成后发送到 QQ，以及账号配额、403/401/429/503、模型代理、凭据、Docker 网络和 8045。用户要求生成/画/创作普通图片时必须使用 image-generate；若用户要求“搜索角色/物品的立绘或图片，再按该图生成/重绘/修改”，必须使用 official-image-generate 或 official-image-generate-multi，固定按中文维基百科优先、萌娘百科回退的顺序获取角色参考图，绝不可回退为纯文生图、搜索缩略图、meme-maker 或 diagram-maker。
metadata:
  openclaw:
    emoji: "🚀"
    os: ["linux"]
    requires:
      bins: ["bash", "base64", "curl", "docker", "ffprobe", "file", "jq", "ss"]
---

# agy 与 Antigravity Manager 代理

本机使用 `agy` 的 Google/Antigravity 登录凭据，通过 Docker 中的 Antigravity Manager 转换为 OpenAI、Anthropic 和 Gemini 兼容 API。先诊断，再修改；任何凭据导入、容器重建、服务重启、端口或配置修改都必须走频道审批流程。

## 本机布局

- `agy`：`/root/.local/bin/agy`
- `agy` 实际登录凭据：`/root/.gemini/antigravity-cli/antigravity-oauth-token`
- 普通 Gemini CLI 凭据：`/root/.gemini/oauth_creds.json`
- Manager 容器：`antigravity-manager`
- Manager 镜像：`lbjlaq/antigravity-manager:latest`
- Manager 数据：`/root/.antigravity_tools`
- Manager 配置：`/root/.antigravity_tools/gui_config.json`
- Manager 账号：`/root/.antigravity_tools/accounts/*.json`
- 本机 API：`http://127.0.0.1:8045/v1`
- 局域网网页：`http://192.0.2.10:8045`
- 局域网 API：`http://192.0.2.10:8045/v1`
- Docker 上游代理：`http://192.0.2.10:7892`
- 代理桥：`docker-mihomo-proxy.socket`，将 `192.0.2.10:7892` 转发到宿主机 mihomo `127.0.0.1:7890`
- FRP 客户端：`frpc.service`，配置 `/root/frp_0.65.0_linux_amd64/frpc.toml`
- OpenClaw 配置：`/root/.openclaw/openclaw.json` 中 provider `antigravity`
- 固定诊断脚本：`{baseDir}/scripts/agy-proxy-diagnose.sh`

## 最重要的凭据规则

`agy` 当前真正使用的是：

```text
/root/.gemini/antigravity-cli/antigravity-oauth-token
```

不要把下面这个文件当作 `agy` Token 导入 Manager：

```text
/root/.gemini/oauth_creds.json
```

后者是普通 Gemini CLI OAuth 凭据。它可以正常刷新 Google Access Token，但用于 Antigravity Manager 的 `cloudcode-pa` 配额和推理端点时会得到 `403 PERMISSION_DENIED`。本机 `agy` 专用 Token 使用 Manager 内置的 `antigravity_enterprise` OAuth Client，无需额外设置 `ANTIGRAVITY_OAUTH_CLIENTS`。

永远不要直接输出 OAuth Token、API Key、Web 管理密码或完整账号 JSON。只检查字段是否存在、Token 是否过期、OAuth Client 名称和模型数量。

## 标准检查

状态问题优先只运行一次：

```bash
/root/.openclaw/workspace/skills/agy-proxy/scripts/agy-proxy-diagnose.sh all
```

针对性检查：

```bash
/root/.openclaw/workspace/skills/agy-proxy/scripts/agy-proxy-diagnose.sh status
/root/.openclaw/workspace/skills/agy-proxy/scripts/agy-proxy-diagnose.sh credentials
/root/.openclaw/workspace/skills/agy-proxy/scripts/agy-proxy-diagnose.sh models
/root/.openclaw/workspace/skills/agy-proxy/scripts/agy-proxy-diagnose.sh quota
/root/.openclaw/workspace/skills/agy-proxy/scripts/agy-proxy-diagnose.sh image-probe

# 生成一张图片并输出可发送的本地路径（会消耗图片配额）
/root/.openclaw/workspace/skills/agy-proxy/scripts/agy-proxy-diagnose.sh image-generate "一只戴宇航员头盔的橘猫，电影级光照"
```

检查每个账号的模型剩余百分比、模型重置时间，以及存在时的 weekly/5h 配额桶：

```bash
/root/.openclaw/workspace/skills/agy-proxy/scripts/agy-proxy-diagnose.sh quota
```

请求 Manager 重新从 Google 刷新所有账号配额，然后输出刷新结果和最新配额：

```bash
/root/.openclaw/workspace/skills/agy-proxy/scripts/agy-proxy-diagnose.sh refresh
```

默认额度回复只报告 `gemini-3.1-flash-image`、`gemini-3.8-flash-high`、`claude-opus-5-5-low` 的 5 小时与周配额及北京时间重置时间。两项 Gemini 共用 `gemini-5h` / `gemini-weekly`，Claude 使用 `3p-5h` / `3p-weekly`。不要把模型级 `percentage` 当作某个窗口；缺失的窗口明确说未知。仅摘取这些事实，以当前角色人设自然回复，保留缓存或刷新失败提示，不转发其他模型、账号身份或原始日志。业务工具 `quota_query` / `quota_refresh` 已完成此筛选。

`refresh` 会访问 Google 配额接口并更新本地账号状态；`quota` 只读 Manager 本地管理 API，不会消耗模型推理配额。固定脚本已加入 `main` agent 的命令白名单，以上查询、刷新和其他固定子命令均直接执行，不再单独请求审批；不得改用临时 `curl` 或其他命令绕开该脚本。

## 图片生成 API

生图使用专用提供商 OpenAI 兼容端点：

```text
POST https://provider.example.invalid/v1/images/generations
```

- GPT 提供商：`https://provider.example.invalid/v1`，统一用于 GPT 文本、提示词优化后备、Images Generations/Edits 与原生 GPT Responses 生图。文本配置保留兼容 provider 名 `novacode-gpt`；图片凭据仍通过受限文件读取。Gemini 与 Grok 的提供商独立配置，保持原样。
- 生图模型：`gpt-image-2`
- Prompt 优化首选：`antigravity/gemini-3.8-flash-high`（high，通过本机已配置 provider 调用）。
- 提示词优化原则：`SEMANTIC FIDELITY > VISUAL RICHNESS`（视觉语义转换，禁止多余语义扩写与主观脑补）。
  1. **风格控制**：若用户未指定艺术风格，默认使用**类原神 2D 简约动漫 CG 风格**（`Genshin-Impact-inspired 2D anime CG style with clean lines, simple shapes, vibrant anime shading, and limited visual details`）；若用户明确指定了其他风格（写实、水彩、赛博朋克等），完全覆盖默认风格。
  2. **视觉语义转换**：仅明确空间关系、动作指向、主体位置与基础构图，禁止臆造发型/五官/服装细节/情绪/光效等未提供信息。
  3. **专有名词**：保留 Elysia、Kiana 等角色专有名词，不进行过度外貌描述扩写。
- 自动流程：生图前优先由 Gemini 3.8 Flash High 按既有规则优化提示词，然后送入 `gpt-image-2` 进行高画质生成。图片模型不变。
- Prompt 优化回退：托管 `antigravity/gemini-3.8-flash-high` → 直连 `gpt-6-luna`（生图专用凭证）→ 托管 `novacode-gpt/gpt-6-luna`（独立 GPT Key）→ 托管 `grok/grok-4.7` → 原始指令。托管优化 agent 禁用工具，脚本不直接读取这些 provider 的 API Key。
- 调用超时：群聊/私聊生图任务上限 60 分钟（3600 秒）；固定脚本使用 `exec timeout: 3300`，为最终校验与投递留出余量。脚本有总计 3300 秒的请求预算，每次生成最长 900 秒，默认最多 3 次尝试（首次 + 2 次重试）；重试等待 5 秒、10 秒。一次脚本调用已经包含网络重试和质量重画，不要在外层重复执行脚本或探针。
- `image-generate`、图片编辑、图片探针和参考图 SSE 生图均使用 `scripts/image-request-policy.sh`。`IMAGE_REQUEST_TIMEOUT` 默认 900（最大 1800），`IMAGE_MAX_ATTEMPTS` 默认 3（最大 5），`IMAGE_RETRY_DELAY` 默认 5（最大 60），`IMAGE_WORKFLOW_TIMEOUT` 默认 3300（最大 3300），值均为正整数。单次实际等待还受剩余总预算限制；连接超时 30 秒。临时网络故障、超时、HTTP 408/425/429/临时 5xx、非法 JSON 和未完成 SSE 可重试；400/401/403/404/413、明确拒绝和已完成响应不重试。请求重试可能额外消耗上游图片额度，但只会输出最终成功的一张图，不会因此重复向 QQ 投递。
- 提示词优化每阶段由 60 秒增加至 120 秒，按 Gemini → 直接 GPT → 托管 GPT → Grok 回退；视觉验收每次由 120 秒增加至 180 秒，保留主模型/备用/主模型的最多 3 次尝试。必须同时检查 `image_generate_curl_exit=0`、合法 JSON 和实际图片，不能仅凭 HTTP 200 判断成功。重试失败响应、错误及响应头保留为权限受限的本地文件，只输出路径，不得发到群里。鉴权和参数错误应立即报告，不要通过外层重试消耗预算。
- 视觉验收只读取非 `thought` 文本，并使用 8192 输出 token 上限，避免推理占用预算导致 JSON 截断。HTTP 200 但验收 JSON 缺失或字段类型无效时，也进入现有最多三次模型尝试；明确验收不通过时保留该候选和真实评分，携带具体错误生成下一张，并对新图重新验收；不重复审查同一张图来覆盖拒绝结果。
- 错误留痕：每次图片 HTTP 尝试通过 `scripts/image-diagnostics.py` 保存脱敏结构化记录至 `/root/.openclaw/state/image-diagnostics/attempt-<uuid>.json`，包含接口/模型、尝试序号、耗时、HTTP/curl 状态、上游请求编号和受限错误摘要。401/403 等永久失败及 HTTP 200 无图片也保留原始响应、stderr、响应头的本机证据路径；日志目录 0700、文件 0600。原始证据可能包含隐私数据，不得输出正文或发群。OneBot 直接图片流程在同目录写 `<trace-id>.jsonl`，以 `AGY_IMAGE_TRACE_ID` 关联请求尝试，并区分生成、文件校验、图片投递和确认文字阶段。只记录识别出的状态行，不保存完整命令/提示词/Base64；即使最终重试成功也保留先前失败记录。`IMAGE_DIAGNOSTICS_DIR` 仅供本机测试重定向，诊断写入失败不改变生成和重试语义。
- 质量复核覆盖 `image-generate`、`image-edit`、`image-edit-reference` 和所有角色参考图生成入口。`IMAGE_QUALITY_MAX_ATTEMPTS` 默认 3、最大 3，表示最多 3 张候选（首次＋最多 2 次重画），与单次 HTTP 网络重试分开计数，共享原有 3300 秒总预算。若提前出现达标图立即采用；若 3 张均成功生成、完成有效评分且均不达标，按本机计算的总分选最高一张发送/发布（同分取先生成者），不再要求其达到阈值，严重结构错误也只保留扣分与诊断，不作为此最终选用步骤的禁用条件。网络失败、无图或无法评分不算成功候选，未满 3 张不得触发此例外。只有真实验收拒绝才重画；验收服务故障只重试验收，明确拒绝/鉴权/执行错误不通过质量循环重复请求。
- 每张完成验收的图片保存 `<图片路径>.quality.json`，包含版本 `anatomy-v1`、图片 SHA-256、身体分、符合度、总分、结构错误和结论。每日空间发布必须核对当前版本、图片哈希，以及通过结论或经校验的三张最高分选用记录；不允许凭旧版 `imageVerified=true` 发布。`image-verify <本地图片> <要求>` 只做当前质量复核，不生图、不发送。复核已有待验收图不通过时，按剩余候选预算重画，跨重新验收也不能重置次数。
- 同一请求先前已成功完成提示词优化时，可用 `IMAGE_OPTIMIZED_PROMPT_FILE` 指向本机保存的该次优化文本，在重试中复用；不得将其他请求或未经核实的文本冒充该次优化结果。
- 优化备用调用必须同时满足 CLI 成功、结果未标记 aborted/error，且正文不是运行时超时或上游错误。即便外层 JSON 标记成功，`Request timed out before a response was generated` 等错误文本也不能当作提示词；缓存优化文本同样受此检查。普通文生图完成后仍应核对画面是否符合原请求，再进入发送。

### 生成并发送到 QQ

当用户明确要求“生成图片并发给我”时，必须使用 Images API 真实生成，不得用搜索结果、Wiki 图片或普通网页图片替代生成结果。

推荐直接运行固定脚本：

```bash
/root/.openclaw/workspace/skills/agy-proxy/scripts/agy-proxy-diagnose.sh image-generate "图片描述"
```

脚本会自动执行：
1. 优先调用 `gemini-3.8-flash-high` (high) 按语义忠实规则完成提示词优化。
2. 调用 `gpt-image-2` 接口生成图片并保存在 `/tmp`。
3. 成功后输出脱敏诊断信息与 `image_output` 本地路径。

随后通过当前消息通道发送该路径；对于 OneBot/LLBot，使用以下格式让出站层识别媒体：

```text
MEDIA:/tmp/agy-proxy-generated-<id>.png
图片说明文字
```

规则：

- 必须先确认 HTTP 2xx、`data` 至少有一项，并成功解码为真实图片文件。
- 优先保留 API 返回的实际 MIME 类型和扩展名，不要固定把 JPEG 命名为 PNG，或反之。
- 发送给 OneBot 时传本地路径；当前 OneBot 出站层也支持 `http(s)` URL，但本地路径更可靠，且由出站层负责清理/共享目录映射。
- 不要把 Base64、完整 API 响应、API Key 或临时文件内容写入聊天或日志。
- 图片发送失败时明确报告“图片未送达”，不得只发送“已发送”或把远程 URL 当作已完成。
- 若用户只要求查找/展示现有图片，才可以使用搜索或网页图片；这与“生成图片”请求严格区分。

`image-generate` 只负责生成并保存本地文件，不自动发送 QQ；实际发送由当前频道的媒体投递链路完成。若模型输出媒体标记，必须使用 `MEDIA:<local-path>`，不要输出 `Attachment: https://...` 代替媒体。

### 以图生图

当用户的本条消息带有图片，或用户引用一条带图片的消息，并明确要求“以图生图”“基于这张图修改”“把这张图改成...”“保留主体重绘”等编辑语义时，必须使用 `gpt-image-2` 的 Images Edits 接口，不能改用纯文生图。

OneBot 入站上下文会提供 `[Image-edit source path: ...]`。对每个要编辑的来源图，运行：

```bash
/root/.openclaw/workspace/skills/agy-proxy/scripts/agy-proxy-diagnose.sh image-edit "/root/.openclaw/workspace/media/inbound/<staged>/<image>.png" "修改说明"
```

规则：

- 只有用户明确要求基于所附或引用图片修改时才使用 `image-edit`；没有来源图或只是普通“生成一张图片”请求时使用 `image-generate`。
- 必须使用上下文提供的入站图片路径，不得猜测路径或上传其他本地文件。
- 编辑说明同样先经 Prompt Optimizer 处理，并保留用户明确要求的变更内容。
- 成功后读取 `image_output`，通过 `MEDIA:<local-path>` 发送编辑后的图片。

### 网络角色参考图以图生图

当用户明确要求“搜索某角色/物品的立绘或图片，然后按这张图生成/重绘/修改图片”时，必须按以下顺序执行：

1. 直接运行固定的一体化命令，不得依据模型记忆、搜狗摘要或临时 Python 抓取断言角色不存在：

```bash
/root/.openclaw/workspace/skills/agy-proxy/scripts/agy-proxy-diagnose.sh official-image-generate "游戏名 角色名 官方立绘" "用户要求的场景与风格"
```

涉及两个或更多角色时，每个角色必须有独立查询，并以全角中文逗号 `，` 分隔：

```bash
/root/.openclaw/workspace/skills/agy-proxy/scripts/agy-proxy-diagnose.sh official-image-generate-multi "游戏名 角色甲，游戏名 角色乙" "用户要求的双角色场景与风格"
```

2. 命令内部先调用中文维基百科 MediaWiki API 搜索独立角色条目，同时解析 `pageimages.original` 主图和条目文件列表。维基百科没有独立角色页、没有合格角色图或候选被判定为游戏主页/列表/界面图时，才切换到萌娘百科执行相同的条目与文件解析。萌娘百科中只有文件候选同时匹配角色身份并带有 `立绘`/`全身`/`角色图` 等强语义时，才覆盖条目主图。
3. 萌娘百科图片只接受 `storage.moegirl.org.cn` 或 `img.moegirl.org.cn`；维基百科图片只接受 `upload.wikimedia.org`。候选图片必须使用 HTTPS，下载后验证为 JPEG、PNG 或 WebP，且宽高均不低于 200 像素。禁止使用搜索缩略图、SVG 图标、Logo、消歧义图、地图、声优照片或 Cosplay 图片替代角色立绘。
4. 条目选择同时比较搜索排名、标题是否包含用户查询中的角色名、摘要是否明确描述“登场角色/虚构角色”，并对标题或摘要中明确出现指定游戏名的候选加权，避免同名角色跨游戏串线。列表、音乐、用语、武器、NPC、公司和家族页面降权；维基百科无独立角色页或无角色图片时必须明确失败，不能使用游戏封面、Logo、界面截图或角色列表页代替。
5. 成功后以 `MEDIA:<image_output>` 发送最终图片；不要发送参考图 URL 替代生成结果。

同一角色的不同形态、战衣或皮肤必须作为不同视觉身份精确检索：

- 查询包含“律者、巡猎、存护、形态、皮肤、装扮、时装、战衣、泳装、礼服、婚纱”等形态语义时，优先检索萌娘百科的 `角色名/形态名` 子条目，因为中文维基通常只有基础角色条目。
- 子条目命中后优先使用该子条目的 `pageimages.original`，例如“人之律者爱莉希雅”必须解析到 `爱莉希雅/真我·人之律者`，不能回退到普通爱莉希雅立绘。
- 没有独立子条目时，从基础角色页文件列表中移除游戏名、角色名及“图片/立绘/皮肤”等通用词，得到形态关键词；只有文件标题包含该形态关键词时才接受。存在形态要求却没有精确文件匹配时必须失败，不能静默使用默认立绘。
- 文件名匹配会统一常见跨语言形态词，例如 `Swimsuit`、`水着` 与“泳装”，以及 `Wedding`、`Bridal` 与“婚纱”。文件名仍无法表达皮肤名时，只接受角色页面中以定义项 `<dt>` 明确标注该形态名并紧邻图片的映射，例如“花时来信”映射到内部文件名 `Ayaka costume 1.png`；不得按页面中任意相邻图片猜测。
- 完整查询搜索不到角色页时，会去掉末尾形态/皮肤短语再定位基础角色页，然后回到原始完整查询执行严格形态匹配。例如先用“原神 神里绫华”定位页面，再以“花时来信”选择图片。
- 多形态生成按最终参考图 URL 去重，而不是按基础角色名去重。同一角色的两个形态只要参考图 URL 不同，就必须保留为两个有序参考输入，并在身份映射中保留完整形态名。
- 中文维基百科及 `upload.wikimedia.org` 属境外来源，固定走 `http://127.0.0.1:7890`；萌娘百科及其 `.cn` 图片域名保持直连。

角色参考图只用于锁定角色身份与服装设计，不用于继承立绘姿势或版式。固定脚本会建立参考图顺序与角色身份的映射，并要求图像生成模型：

- 只保留脸部、发型、服装、配饰与配色等身份特征。
- 忽略参考图的姿势、身体朝向、视线、手势、裁切、镜头角度、构图位置、比例、背景和光线。
- 对每个角色明确场景驱动的躯干朝向、头部或视线目标、动作阶段、重心或肢体受力，以及与其他人物或物体的空间关系。
- 除非用户明确要求正面肖像或直视观众，角色必须看向互动对象、相关物品或运动方向，并优先使用侧面、三分之二侧面、侧后方或过肩角度。
- 战斗、追逐、行走、舞蹈、拥抱、对话、观察、驾驶、搬运和物品操作等场景必须表现动作进行中的状态，不能退化为正面站立展示。
- 按用户要求重新设计动作与空间关系，并让所有角色处于统一透视、比例、地面和光照中；禁止把角色画成沿用立绘姿势的并排贴图、对称站队或拼贴画。

角色参考图编排优先使用本机 Gemini 3.8 Flash High 的 Responses 接口，传入全部有序参考图，要求返回严格 JSON 生成方案（action=generate、prompt）。本机 Responses 是兼容转换接口，不能执行 GPT 专用的内置 image_generation 工具，因此由固定脚本把有效方案和全部已验证参考图提交给 GPT Image 2 的 Images Edits；通过参考图专用提示词强调身份引用、全新动作和构图，随后严格视觉验收，不能宣称天然等价于原生 action=generate。只有 Gemini 规划接口不可用或输出结构无效时，才退回 GPT-6 Luna Responses + GPT Image 2 的原生工具流程；规划明确拒绝、鉴权错误或执行失败不进行模型切换或外层盲目重试；唯一新增候选的情形是已完成图片被视觉验收明确判为不合格，按质量策略有限重画。用户明确的服装变化覆盖参考服装。

所有角色参考图生成完成后必须通过独立视觉验收，检查可见人物数量、指定身份是否齐全、有无额外人物、服装、核心场景与动作是否匹配、身份映射是否可信、是否真正替换了参考图姿势与布局，以及 `scene_directed_pose_and_gaze` 是否成立。动作或互动场景中若角色无理由正面直视观众、视线和手势未指向互动对象、重心不支持动作，或镜头仍像静态角色站队，必须拒绝；用户明确要求正面肖像或直视观众时除外。验收增加 `anatomy_score`、`anatomy_consistent` 和 `severe_anatomy_errors`。本机计算总分＝身体结构分×70%＋角色/场景符合度×30%；要求身体结构分≥90、总分≥85、严重结构错误列表为空、人物数准确且所有布尔检查通过，才按正常验收输出 `image_output`。多头、多躯干、多余/融合/断裂肢体、明显多指或不可能的关节连接会判为不达标，高符合度不能抵消正常验收结论；正常遮挡、裁切、透视及明确要求的非人类结构不误判。但用户已于 2026-10-16 要求：3 张成功生成并评分的候选都未达标时，选总分最高的一张；该图仍记录 `passed:false`，同时设置 `accepted_for_delivery:true` 和 `selection.policy=best-of-three-v1`，附三张评估与哈希证据，不伪装成验收通过。只有被选中的图片输出 `image_output`。HTTP 200 或存在有效 PNG 本身不代表成功。

`official-image-generate` 与 `official-image-generate-multi` 是保留的兼容命令名，会把萌娘百科/维基百科搜索、Responses 新图生成和视觉验收压缩为一次受信任调用。单角色与多角色参考图都以 HTTPS URL 输入 Gemini Responses；成功规划后本机下载并校验全部参考图，提交 GPT Image 2，再进行视觉验收。原生 GPT 后备路径仍通过 Responses image_generation。中间下载参考文件在结束后清理。固定命令失败后必须直接报告失败，不得继续调用 `character-search`、`web_fetch`、`curl`、临时 Python 或手工 `image-edit-reference`；也不能改用 `image-generate` 伪装为参考图生图。

### Python 调用

```python
import base64
from openai import OpenAI

client = OpenAI(
    api_key="<API_KEY>",
    base_url="http://127.0.0.1:8045/v1",
)

response = client.images.generate(
    model="gemini-3.1-flash-image",
    prompt="一只戴宇航员头盔的橘猫，电影级光照",
    size="1024x1024",
    quality="standard",
    n=1,
    output_format="png",
)

with open("generated-image.jpg", "wb") as output:
    output.write(base64.b64decode(response.data[0].b64_json))
```

### 参数

- `model`：优先使用 `quota` 中真实存在的图像模型
- `prompt`：图片描述
- `size`：默认 `3840x2160`（4K，可通过环境变量 `IMAGE_SIZE` 覆盖）。官方推荐 `1024x1024`、`1536x1024`、`1024x1536`；自定义尺寸必须同时满足：宽高为 16 的倍数、任一边不超过 3840、宽高比在 1:3 到 3:1 之间、总像素在 655,360 到 8,294,400 之间；超过 `2560x1440` 属于实验性分辨率。不存在 `4K`/`imageSize` 这类取值，必须写显式像素
- `quality`：默认 `high`（可通过环境变量 `IMAGE_QUALITY` 覆盖）；官方支持 `low`、`medium`、`high`、`xhigh`、`max`、`auto`
- `n`：生成数量，增加数量会增加耗时和配额消耗
- `output_format`：官方优先使用 `png` 或 `webp`；落盘后仍必须通过 MIME/文件头确认真实格式，不要只相信扩展名
- 发送路径：生成结果必须先落盘为本地文件，再通过 `MEDIA:<local-path>` 或频道原生媒体字段发送

### 生图排障

- `502 No accounts available with quota`：请求模型不在账号真实配额中；运行 `quota` 并改用真实图像模型
- `429 All accounts exhausted`：图像额度耗尽或临时限流；检查剩余百分比和重置时间
- `403 PERMISSION_DENIED`：先确认导入的是 `antigravity-oauth-token`，并检查无项目 Header 重试是否成功
- `200` 但没有 `data[0].b64_json`：检查返回 JSON 的 `error`、`data` 和模型兼容性，不要把空字段写成图片
- 出现 `OneBot sendMedia currently supports local file paths only`：说明旧版出站层未支持远程 URL；先落盘后发送，不要直接把 URL 当作本地文件
- 出现 `路径不存在`：确认图片路径位于 OneBot/LLBot 共享目录，或让当前出站层重新下载远程媒体；不要报告发送成功
- 大图 `413`：确认 `ABV_MAX_BODY_SIZE=104857600`
- 请求超时：图片请求单次 900 秒、最多 3 次尝试，脚本执行上限 3300 秒，频道/agent 生图任务上限 3600 秒；普通聊天超时保持原设置。
- 提供商对 `size`/`quality` 的实际支持需按当前模型重新探针确认；脚本默认 `IMAGE_SIZE=3840x2160`、`IMAGE_QUALITY=high` 已配置，若上游忽略这些参数，以实际返回图片为准
- 官方调用方式（2026-09-09 文档）：Image API 的模型 ID 为 `gpt-image-2`，直接生成/编辑使用 `v1/images/generations` 与 `v1/images/edits`；Responses 流程必须把模型显式写在 `image_generation` 工具的 `model` 字段，外层使用支持该工具的语言模型
- 参考图 Gemini Responses 规划使用非流式严格 JSON，`IMAGE_RESPONSES_MODEL` 默认 `gemini-3.8-flash-high`，`IMAGE_REFERENCE_PLAN_URL` 默认本机 `/v1/responses`；`IMAGE_REFERENCE_FALLBACK_MODEL` 默认 `gpt-6-luna`。GPT 后备 Responses 生图使用 SSE 流式响应，持续接收 `response.*` 事件并从 `response.completed` 提取最终图片，避免同步请求长时间无数据被 CDN 以 HTTP 524 截断。
- 当前提供商不支持 `background: true` 或 `GET /v1/responses/{id}`。每次请求会记录并发送 `client_request_id`，收到创建事件后还会记录 `response_id`；若流中断则报告 `stream-incomplete`。这些 ID 仅供上游管理员人工查日志，不能通过公开 API 轮询找回；不得声称任务仍可自动恢复。
- 后置视觉验收会依次尝试 `gemini-3.8-flash-high`、`gemini-3.1-flash-lite`，再退避重试主模型。HTTP 429、5xx、超时、无效 JSON 或验收模型结构异常属于 `visual-verification-unavailable`，不是图片内容不合格。
- 只有验收模型明确返回身体结构、场景、身份、人数、姿势或布局不合格时才启动下一次质量重画；暂存其图片和评分，供三张均未达标时选最高分。将具体错误加入纠错提示词，在同一链路重新生图、重新验收，最后只保留选中图。验收服务不可用时，将图片和 Prompt、参考图、`response_id`、`client_request_id` 保存到 `/root/.openclaw/state/agy-proxy-pending/latest.json`，不得删除或发送未经验证的图片。
- 用户要求“发送刚才生成的图片”“重新检查上一张图片”时，只运行固定子命令：

```bash
/root/.openclaw/workspace/skills/agy-proxy/scripts/agy-proxy-diagnose.sh reference-reverify-latest
```

- `reference-reverify-latest` 返回 `image_output` 后才能发送 `MEDIA:<local-path>`；返回 `visual-verification-unavailable` 时保留图片并说明仍待验证；若最终返回 `image_quality_selection=best-of-three` 与 `image_output`，按三张最高分例外选用，不宣称其达到阈值；若没有最终 `image_output` 则不可发送。不要使用 `ls /tmp`、`find` 或临时脚本寻找上一张图片。
- 未成功执行一次重新验收前，不得声称“校验服务已经恢复”“现在已经冷却完成”。

仅在用户要求实际调用或只读结果不足时运行推理探针。它会消耗少量模型配额：

```bash
/root/.openclaw/workspace/skills/agy-proxy/scripts/agy-proxy-diagnose.sh probe
```

## 正常状态判定

- `agy --version` 正常，专用凭据 JSON 包含 `token.refresh_token` 和 `token.access_token`
- 容器 `antigravity-manager` 为 `Up`
- `127.0.0.1:8045` 与 `192.0.2.10:8045` 均在监听
- `/health` 返回 `200`
- `/api/proxy/status` 显示 `running=true` 且 `active_accounts>=1`
- 账号 `disabled=false`、`quota.is_forbidden=false`、`token.oauth_client_key=antigravity_enterprise`
- 账号配额模型数量大于 0
- `/v1/models` 返回 `200` 且模型数量大于 0
- 推理探针返回 `200`，内容包含 `OK`
- `docker-mihomo-proxy.socket` 为 active，Manager 的 `upstream_proxy` 指向 `http://192.0.2.10:7892`

## 导入 agy 凭据

导入会写 Manager 账号数据并访问 Google OAuth/配额服务，执行前必须获得审批。

1. 确认读取的是 `antigravity-oauth-token`，不是 `oauth_creds.json`。
2. 从 Manager 容器环境读取 Web 管理密码，不要打印。
3. 将 `token.refresh_token` 通过标准输入传给本机管理 API，避免出现在命令参数和日志中：

```bash
web_password=$(docker inspect antigravity-manager | jq -r '.[0].Config.Env[] | select(startswith("WEB_PASSWORD=")) | sub("^WEB_PASSWORD=";"")')
jq -c '{refreshToken:.token.refresh_token}' /root/.gemini/antigravity-cli/antigravity-oauth-token \
  | curl --silent --show-error --fail-with-body --max-time 150 \
      -H 'Content-Type: application/json' \
      -H "Authorization: Bearer $web_password" \
      -H "x-api-key: $web_password" \
      --data-binary @- \
      http://127.0.0.1:8045/api/accounts
```

4. 验证保存后的账号应为 `oauth_client_key=antigravity_enterprise`，配额模型大于 0且未 forbidden。
5. 再运行 `/v1/models` 和最小推理探针。

导入同一邮箱会更新已有账号，不需要手工编辑账号 JSON。不要通过伪造配额模型、永久关闭自动刷新或手工清除 forbidden 来掩盖错误 Token；这些方法只会延迟暴露真正的 403。

## Docker 与网络配置

当前容器应保留：

- `--restart unless-stopped`
- `-p 127.0.0.1:8045:8045`
- `-p 192.0.2.10:8045:8045`
- `-v /root/.antigravity_tools:/root/.antigravity_tools`
- API Key 与 Web 管理密码分离

不要改成 `-p 8045:8045` 或绑定 `0.0.0.0`，除非用户明确要求向所有接口开放。局域网只使用 `192.0.2.10:8045`，本机与潜在 FRP 使用 `127.0.0.1:8045`。

Manager 容器不能直接访问宿主机 `127.0.0.1:7890`。本机使用 systemd socket bridge：

```text
Manager -> http://192.0.2.10:7892 -> docker-mihomo-proxy.socket -> http://127.0.0.1:7890
```

若 OAuth 请求超时，依次检查：

```bash
systemctl status docker-mihomo-proxy.socket --no-pager
ss -ltnp | grep -E ':7890|:7892'
jq '.proxy.upstream_proxy' /root/.antigravity_tools/gui_config.json
docker logs --tail 100 antigravity-manager
```

修改 `gui_config.json` 中的上游代理后必须重启容器，因为共享 HTTP Client 为懒加载单例。重启 Docker/容器属于关键服务操作，需审批。

## 403 排障

按以下顺序判断：

1. `agy` 实际推理是否成功。成功说明账号与专用凭据可用。
2. Manager 保存的 `oauth_client_key` 是否为 `antigravity_enterprise`。
3. 配额是否 `is_forbidden=true` 或模型列表为空。
4. Manager 日志是否先出现项目 Header 403，随后无 Header 重试成功。一次项目 Header 403 后自动成功是已知兼容路径，不代表最终失败。
5. 若配额和最终推理都返回纯 `PERMISSION_DENIED`，确认是否误导入了 `/root/.gemini/oauth_creds.json`。
6. `gcloud auth login --update-adc` 只更新 Google Cloud ADC，不能替代 `agy` 专用 Token，也不是修复错误导入的主要方法。

错误解释：

- `401 Unauthorized`：调用 API Key 错误，或 Google Access Token 无效
- `403 PERMISSION_DENIED`：Token 来源错误、账号权限或项目 Header 不兼容
- `429 All accounts exhausted`：所有账号限流或配额耗尽
- `503 Token pool is empty`：没有可调度账号，常见于 forbidden、disabled 或未加载账号
- `No accounts available with quota for model`：账号配额模型列表为空或不包含归一化模型名

## FRP

不要假设 8045 一定配置了 FRP。当前配置可能仅保留 SSH。每次先读：

```bash
grep -E 'name|localPort|remotePort' /root/frp_0.65.0_linux_amd64/frpc.toml
systemctl status frpc --no-pager
```

只有用户明确要求公网映射并批准配置修改后，才添加 8045 TCP proxy。FRP 使用明文 HTTP 暴露 API Key，优先建议局域网、VPN 或 HTTPS 反向代理。

## OpenClaw provider

OpenClaw 当前应使用：

- provider：`antigravity`
- base URL：`http://127.0.0.1:8045/v1`
- API：`openai-completions`
- API Key：通过 secret/exec provider `antigravity_key` 获取
- `request.allowPrivateNetwork=true`

不要把 API Key 写入 skill、聊天回复或 `openclaw.json` 明文字段。排查 OpenClaw 调用时先确认 Manager 本机探针成功，再检查 provider 和 secret provider，避免把上游 403误判为 OpenClaw 配置错误。

## 回复格式

对 QQ 用户使用简洁中文：

```text
状态：正常 / 异常 / 需确认
agy：版本、凭据是否存在、实际推理是否成功
Manager：容器、监听地址、账号数、配额模型数
API：health/models/probe HTTP 状态
网络：mihomo bridge 与局域网地址
原因：只给最直接根因
下一步：仅给一个最小动作；需修改时等待频道审批
```

不要输出原始 Token、API Key、管理密码、完整邮箱、完整账号 JSON 或长日志。

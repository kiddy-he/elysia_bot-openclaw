# OneBot custom source

Feature/identity/group authorization is centralized in `../onebot-features.json`.
See [FEATURES.md](FEATURES.md) for the 14-module catalog, effective permission
matrix, fail-closed hooks, scheduled-task bindings and migration boundaries.
Run `npm run features:check`, `features:matrix` or `features:sync` to validate,
inspect or apply compatibility mirrors and declared scheduler enablement.

QQ display names and group-history text discard transport control characters
before entering prompts. `text-boundary.js` also normalizes only OpenClaw agent
`--message` payloads at the process boundary, including old transcript context,
so a NUL in a historical nickname cannot prevent review, Qwen/Grok fallback or
persona rendering from starting. Executables, shell commands, file paths,
recipient ids and authorization checks are unchanged. Review/rewrite errors log
codes instead of Node's argument-validation message, which can contain prompts.

`src/src/turn-intent.js` classifies search, image generation, official references,
backend actions, `speech_mode` and `reminder_action` in the same inbound model request. Speech is
`answer`, `literal`, `disabled` or `none`; it is never inferred from regexes or
keyword lists. Normal conversations and private guests use Gemini Lite; isolated
Grok conversations retain their own review provider. Registered scheduled runs
use the same schema before building the main prompt and reuse it within a run.
Classification failures or invalid speech values become `unknown`: text only,
without keyword fallback or a random voice appendix. The classifier does not
grant tools: Elysia-only permission, the 200/40-character limits, guest safety
review and exact-destination delivery checks remain enforced separately.
Search classification favors verification for potentially stale knowledge and
real-world advice, including everyday food, travel, purchases, health, policies
and software usage, even without an explicit request to search. Pure social or
creative replies, stable fundamentals and transformations of supplied material
usually do not need search; explicit requests to stay offline are respected.
This remains a semantic model decision. Existing search permissions and native
Gemini request gating still apply, and a positive intent is not proof of retrieval.
Conversation reminders are available to every admitted admin/member/private guest
through `reminder_create`, `reminder_list` and `reminder_cancel`, with no approval.
The inbound semantic classifier identifies create/list/cancel intent; discussing
timers or reading quoted reminder text does not grant a tool action. One-time
reminders are stored in SQLite and checked every five seconds, including after
restart; overdue reminders can be delivered within 24 hours. Times use Shanghai
unless a full explicit timezone is supplied, with a one-year scheduling horizon.
Only the creator's current conversation can be targeted/listed/cancelled. Group
recipients are resolved against both account nicknames and group cards using
normalized fuzzy matching; ambiguity requires clarification. Delivery uses real
QQ mention segments and the existing durable queue, with persisted content,
destination, permission checks and a stable dedupe identity. Due text is never
executed as a prompt or command. One incoming message creates at most one reminder;
each creator can retain up to 100 unfinished reminders.
Conversation TTS sends its approved artifact through the native durable queue
before returning the tool result. Only a platform receipt sets `delivered=true`;
the destination comes from the bound incoming event, never model parameters.
An operation-based delivery key prevents duplicate synthesis or sends. Final
model media directives and internal paths are suppressed after confirmed speech
delivery; uncertain sends produce an honest full text fallback without replay.

Quoted messages are resolved by `src/src/quoted-message.js`. Every direct reply
in an inbound batch links the current message ID to the quoted message ID and
includes the original author and text, plus media markers and native quoted
images. The same context reaches the conversation, intent context, text review
and fallback models. Empty quoted mentions are explicitly treated as referring
to the original message. Unavailable quotes are labeled instead of guessed.
Lookups share a 15-second budget, deduplicate message IDs and cap five references
and 4000 text characters per quote. Conversation scope is checked before exposing
text or images; private guests and synthetic peer continuations retain their
existing restricted path. Quoted text remains untrusted background and never
changes current-sender authority, command routing or approval identity.

This directory is the editable source of the local OneBot extension. OpenClaw
loads `extensions/openclaw-onebot/dist/index.js`; do not edit its generated
`dist/src` files directly after migrating a feature here.

`npm run check` checks JavaScript syntax and runs focused unit tests without
touching the live plugin. `npm run deploy` validates, backs up existing files to
`state/backups/`, and copies only source-owned JS and declaration files into
the extension's `dist/` directory. Deployment does not restart the Gateway.

The current source is a snapshot of the installed plugin plus local changes.
Refactor modules one boundary at a time while preserving all external entry
points, session keys and shared approval state. Model and role routing remain
in `onebot-model-routing.json` and `onebot-role-routing.json`; provider and
agent registration remain in `openclaw.json`.

After deployment: validate the OpenClaw configuration, restart the user Gateway,
check both OneBot accounts reconnect, then test text, approval, fallback, media,
guest and conversation-mode flows. A successful syntax check alone does not
establish parity for the latter workflows.

Group guests may explicitly select one role and request `/agy quota` or
`/agy refresh` (or a complete equivalent AGY/Gemini quota request in Chinese).
`group-guest-quota.js` handles this before agent dispatch using only the fixed
diagnostic script's `quota`/`refresh` subcommands. Refresh already returns the
remaining quota. Replies contain only quota fields; guest backend authorization,
agent tools and approval access are not expanded. Other or mixed operational
requests follow the existing restricted guest path. Private guests and peer
continuations do not receive this exception.

Command review reads `../relaxed-approval-prompt.txt` on each review and caches by
mtime. `src/src/approval-policy.js` supplies the matching fallback. The policy
allows understood scripts, inline code, shell composition and bounded temporary
or ordinary task-output writes; core program/config changes, service state and
network/system changes still require confirmation. This changes judgement, not
the two-allow-vote quorum or sender permissions. Script evidence explicitly marks
truncated bodies and scripts omitted by the read limit.

Approval GPT and Grok votes use `src/src/approval-review-client.js`: bounded,
non-streaming requests to the existing providers from `openclaw.json`, with the
existing file/env credential references. They do not start agent sessions or
load workspace prompts/tools. GPT retains Luna/max then Sol/high, with a 30s
deadline per model. Grok uses 4.7/low (a supported effort rather than `off`), a
25s first deadline and at most one 20s retry for transient/invalid responses.
HTTP/auth/model failures, incomplete responses and invalid decisions remain
abstentions; the two-allow quorum and the three-Grok special branch are unchanged.
Errors include bounded, sanitized causes instead of CLI arguments or evidence.
These calls connect directly to the configured provider, matching the current
Novacode NO_PROXY routing; they do not use the process proxy environment.

Novacode credentials are separated by provider: `novacode` only contains Qwen and
uses the `novacode_key` secret provider; `novacode-gpt` contains Luna/Sol and uses
`novacode_gpt_key`, a separate mode-0600 file. GPT approval votes and the GPT
agents use `novacode-gpt`; the Qwen conversation fallback retains `novacode`.
The earlier GPT 404 was caused by reusing the Qwen-only credential. A separate
user-provided GPT API credential fixed actual Responses calls on 2026-10-15.
Do not substitute a Codex-only credential: upstream rejects that API route.

Image workflows use a 3600000ms channel limit and an explicit matching agent
timeout override; image-turn exec defaults to 3300s. Direct guest image and edit
paths use the same channel limit. The approval result barrier follows that limit
plus two minutes, so it cannot expire during generation. Approval vote deadlines
are unchanged. The fixed AGY script owns bounded
generation retries (900s per attempt, at most three, 3300s total request budget);
Gateway must not retry image sends without reconciling their platform receipt.

Non-image conversation runs use staged waiting: 180s for ordinary replies and
250s for image understanding trigger a factual progress update, then the same
agent run continues up to `extendedResponseTimeoutMs` (900000ms by default).
Subsequent intervals report progress until completion or that total deadline.
The gateway summarizes only tool steps confirmed by the current request's
execution results, distinguishing failed, pending and uncertain steps. It never
restarts the task or forwards tool arguments, stdout, paths or reasoning as
progress. Final summaries follow any in-flight progress message; resetting or
cancelling a turn discards queued updates and late model replies. Fixed group
quota query/refresh uses its previous 75s/255s limit as the progress interval and
the same longer total deadline. Individual tool limits and approval requirements
remain in force; an external operation can outlive cancellation and is not
blindly retried. Scheduled jobs retain their independent budgets.

`modelReplyTimeoutMs` defaults to 180000ms for isolated text/vision fallback
generation and media completion text. Fallback CLI runs have a 20s process
margin. Media text generation has a 180s limit, independent review 10s, and
195s total preparation/receipt-wait ceilings; generation overlaps media delivery.

`src/src/image-diagnostics.js` assigns each direct image workflow a trace ID and
writes structured stage records to `../state/image-diagnostics/<id>.jsonl` as
well as the Gateway log. Script exit code, signal, killed flag and recognized
stdout/stderr diagnostics survive execFile failures; the command and full
prompts are omitted. Generation, output validation, image send and confirmation
have separate stages; successful image receipts are recorded before confirmation.
The fixed script writes `attempt-<uuid>.json` in the same directory for each
HTTP attempt, including endpoint/model, duration, HTTP/curl status, request ID
and bounded sanitized upstream errors. Retry evidence is kept even when a later
attempt succeeds. Failed responses (including permanent errors) and transport
details remain in private `/tmp` files referenced by these records. Directory
permissions are 0700 and files 0600. Raw response evidence may contain private
data; never publish it or send it to QQ. Diagnostic write failures cannot retry
a request or replace the actual workflow error.


Guest address handling uses `guest-address.js` across inbound instructions,
text review/fallback and outbound rewriting. Private visitors and non-admin
human group senders default to a neutral platform nickname (or “你”). An explicit
neutral chosen name persists by group/private scope and sender in
`state/onebot-guest-addresses.json` (0600); private `/new` clears the choice.
Authority/ambiguous relationship/intimate titles are rejected, and final output
filters direct inappropriate vocatives without rewriting factual third-person
mentions. Admin addressing, peer identities and tool authorization are unchanged.
The three guest workspace address documents follow the same rule; older history
cannot override it.


Native Gemini Google Search is handled by `src/src/gemini-native-search.js`.
Current Antigravity accepts `tools: [{googleSearch:{}}]` on the OpenAI-compatible
chat endpoint; declaring a function named `web_search` no longer activates
server-side execution reliably. Search payloads omit tool_choice and
parallel_tool_calls, remove the internal marker and request source citations.
The modifier only applies to antigravity/gemini-* and the latest user turn (or an
explicit per-call search option); other providers and nonsearch turns retain their
normal tool handling. Search is provider-owned, so local tools.web.search stays
disabled. Only citations/grounding evidence establish a search result.

Two preexisting patches live in the installed OpenClaw stream/proxy adapters.
`npm run search-patch:check` audits them; `npm run search-patch:apply` backs up
and replaces both legacy injectors with imports of the shared native helper.
This is separate from plugin deploy. An OpenClaw upgrade can overwrite these
core files; rerun the audit and review before applying on a changed version.
The patcher fails on an unexpected adapter structure instead of guessing.


Modular operations, native delivery and scoped workspaces are documented in
[FEATURES.md](FEATURES.md). The 22 dedicated executors use event-bound identity,
fixed argv, persisted operations and scoped approvals. Public group/visitor/helper
contexts are isolated from owner-private workspaces. `npm run modular:check`
audits current configuration, service contracts and scheduled jobs.

`npm run test:simulation` runs the real local Gateway against synthetic model
and OneBot endpoints in a separate simulation directory. Its explicit preload
mocks fixed business executors; it never publishes a real Qzone post or sends a
real QQ message. Dialogue, authorization, media, mode, approval restart,
automation and webhook outcomes are asserted and saved as report.json. This is
separate from live upstream acceptance; Bilibili login/monitoring/sends remain
deferred. Simulation logs are private test evidence, not QQ content.

QQ merged chat records are resolved by `src/src/forwarded-message.js` before
model dispatch. Direct `forward` segments, CQ-form forward segments, and native
`com.tencent.multimsg` JSON cards are supported. A quoted record is expanded only
after `get_msg` confirms the quote belongs to the current conversation. Group
mention selection and existing conversation/media/quote policies still apply;
forwarded authors and commands never change the event-bound sender or permissions.

The resolver calls the current account's fixed `get_forward_msg` endpoint with
resource handles supplied by actual message segments. A per-turn cache avoids
repeated lookups. Limits are 5 root records, 3 levels, 12 requests, 80 nodes,
24,000 text characters, 2,000 characters per node, 160 context entries, 6 images,
2 MiB per response, and a shared 15-second lookup deadline. Ordered authors,
timestamps, node positions and failures are serialized as read-only JSON context.
Images use the existing bounded multimodal upload path; only approved QQ CDN
URLs or bounded inline image data are admitted, never host file paths or arbitrary
URLs. Voice, video and files retain explicit unread/transcription markers. Expired
or truncated records are marked rather than invented. The resolver logs only
counts, never resource handles, CDN URLs, record bodies or upstream errors.

`node --test tests/forwarded-message.test.mjs` covers parsing and read boundaries.
`SIMULATION_FILTER='^forward-' npm run test:simulation` verifies the real Gateway
with synthetic records for members, owner private, visitor private, quoted and
nested records, multimodal inputs, permission revocation and mention-only groups.

X/Twitter public post search, inspection and full media delivery use `x_search_posts`,
`x_inspect_posts` and `x_media_workflow`. The semantic inbound classifier sets
`x_operation`; complete albums/videos are sent as per-post nodes in one forward,
with text separately. Public post links work through allowlisted resolvers; keyword
search needs a locally imported X session. See [X media workflow](docs/X-MEDIA-WORKFLOW.md)
for configuration, authentication setup and captured acceptance results.

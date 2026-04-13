# Translation Mapping Ledger

Mapping-focused notes only.

This file is about transcript translation shape, not persistence mechanics.

## Purpose

Track:

1. what shapes exist natively in Claude transcript JSON
2. what shapes exist natively in Codex rollout JSONL
3. how `agent-transcript-parser` currently maps them
4. where the mapping is clean, synthesized, lossy, or still missing

## Terms

- `native`: mapped into a first-class shape that the target system already understands
- `synthesized`: extra target-native records are created to make the transcript load or replay better
- `summary fallback`: no real native equivalent, so we emit visible text or attachment summaries
- `passthrough`: only preserved via `_atp`, not meaningfully translated
- `dropped`: lost in lossy mode or not reconstructed natively

## Mapping Priorities

### Tier 1: resume-critical

These are the shapes and fields that most directly affect whether the resumed
session is structurally usable in the target product:

- Claude `user` tool result linkage:
  - `message.content[*].type = 'tool_result'`
  - top-level `toolUseResult`
  - top-level `sourceToolAssistantUUID`
- Claude visibility / control flags:
  - `isMeta`
  - `isVisibleInTranscriptOnly`
  - `permissionMode`
  - `origin`
- Claude first-class transcript entry types beyond chat:
  - `attachment`
  - `file-history-snapshot`
  - `queue-operation`
  - `last-prompt`
  - `mode`
  - `worktree-state`
  - `content-replacement`
- Codex thread identity and listing fields:
  - `session_meta`
  - `turn_context`
  - `event_msg:user_message`
  - stable `call_id` pairing for call/output items

### Tier 2: render-fidelity

These mainly affect whether the resumed transcript looks complete and natural:

- Claude attachments such as:
  - `queued_command`
  - `edited_text_file`
  - `edited_image_file`
  - `hook_*`
  - `diagnostics`
  - `mcp_resource`
- Codex event stream detail:
  - `exec_command_begin`
  - `exec_command_output_delta`
  - `mcp_tool_call_begin/end`
  - `agent_message_delta`
- media / rich content:
  - images
  - documents
  - PDF-derived content
  - file-read rich tool outputs

### Tier 3: exact round-trip / provenance

- `_atp` sidecars
- translator-only reconstruction hints
- original provider-specific metadata that has no native target meaning

## Source Files

Translator:

- [src/toClaude.ts](/Users/juliusolsson/Desktop/Development/cc-shell/agent-transcript-parser/src/toClaude.ts)
- [src/toCodex.ts](/Users/juliusolsson/Desktop/Development/cc-shell/agent-transcript-parser/src/toCodex.ts)
- [src/types.ts](/Users/juliusolsson/Desktop/Development/cc-shell/agent-transcript-parser/src/types.ts)

Reference shapes:

- [claude-code-headless/src/transcript/TranscriptTypes.ts](/Users/juliusolsson/Desktop/Development/cc-shell/claude-code-headless/src/transcript/TranscriptTypes.ts)
- [codex-headless/src/transcript/TranscriptTypes.ts](/Users/juliusolsson/Desktop/Development/cc-shell/codex-headless/src/transcript/TranscriptTypes.ts)
- [claude-code-src/full/utils/messages.ts](/Users/juliusolsson/Desktop/Development/cc-shell/claude-code-src/full/utils/messages.ts)
- [claude-code-src/full/utils/attachments.ts](/Users/juliusolsson/Desktop/Development/cc-shell/claude-code-src/full/utils/attachments.ts)
- [claude-code-src/full/utils/sessionStorage.ts](/Users/juliusolsson/Desktop/Development/cc-shell/claude-code-src/full/utils/sessionStorage.ts)
- [claude-code-src/full/types/logs.ts](/Users/juliusolsson/Desktop/Development/cc-shell/claude-code-src/full/types/logs.ts)
- [codex-src/codex-rs/state/src/extract.rs](/Users/juliusolsson/Desktop/Development/cc-shell/codex-src/codex-rs/state/src/extract.rs)
- [codex-src/codex-rs/rollout/src/list.rs](/Users/juliusolsson/Desktop/Development/cc-shell/codex-src/codex-rs/rollout/src/list.rs)

## Claude Source Truth

### Core persisted chain

Claude's persisted transcript chain is:

- `user`
- `assistant`
- `attachment`
- `system`

Important negative case:

- `progress` is explicitly not part of the modern transcript chain and should
  not be reintroduced as a primary translated entry type.

### Resume-relevant Claude non-chat entries

These are not cosmetic. Claude loads them back into resume state or transcript
metadata maps:

- `summary`
- `custom-title`
- `ai-title`
- `last-prompt`
- `task-summary`
- `tag`
- `agent-name`
- `agent-color`
- `agent-setting`
- `pr-link`
- `mode`
- `worktree-state`
- `file-history-snapshot`
- `attribution-snapshot`
- `queue-operation`
- `content-replacement`
- `marble-origami-commit`
- `marble-origami-snapshot`
- `speculation-accept`

### Resume-critical top-level Claude fields

#### `user`

High-value stored fields observed in Claude source:

- `uuid`
- `timestamp`
- `message`
- `toolUseResult`
- `sourceToolAssistantUUID`
- `permissionMode`
- `isMeta`
- `isVisibleInTranscriptOnly`
- `origin`
- `imagePasteIds`
- `mcpMeta`
- `parentUuid`
- `logicalParentUuid`
- `isSidechain`
- `userType`
- `entrypoint`
- `cwd`
- `sessionId`
- `version`
- `gitBranch`
- `slug`

#### `assistant`

High-value stored fields observed in Claude source:

- `uuid`
- `timestamp`
- `message`
- `apiError`
- `error`
- `errorDetails`
- `isApiErrorMessage`
- `isVirtual`
- `requestId`
- `isMeta`

Important nested `message` fields:

- `id`
- `container`
- `model`
- `role`
- `stop_reason`
- `stop_sequence`
- `type`
- `usage`
- `content`
- `context_management`

#### `attachment`

Serialized as:

- `{ type: 'attachment', attachment, uuid, timestamp }`

Meaning lives under `attachment.type` and attachment payload fields.

### Claude attachment shapes that matter to translation

Currently highest-value for cross-provider mapping:

- `queued_command`
- `edited_text_file`
- `edited_image_file`
- `hook_stopped_continuation`
- `hook_blocking_error`
- `hook_additional_context`
- `hook_success`
- `hook_error_during_execution`
- `diagnostics`
- `mcp_resource`
- `plan_mode`
- `plan_mode_reentry`
- `plan_mode_exit`
- `auto_mode`
- `auto_mode_exit`
- `date_change`

Important implication:

- Some Codex events are probably better mapped to Claude attachments than to
  plain transcript text because Claude later rehydrates those attachments into
  hidden or visible transcript semantics.

## Codex Source Truth

### Core persisted rollout families

- `session_meta`
- `turn_context`
- `response_item`
- `event_msg`
- `compacted`

### Resume/listing-critical Codex shapes

These are the rollout records most directly used by thread listing, metadata
extraction, and resume:

- `session_meta`
- `turn_context`
- `event_msg:user_message`
- stable `call_id` linkage across:
  - `function_call`
  - `function_call_output`
  - `custom_tool_call`
  - `custom_tool_call_output`

Important implication:

- `response_item:message(role=user)` alone is not enough for native Codex
  listing/title behavior. `event_msg:user_message` matters.

### Codex response-item inventory

- `message`
- `function_call`
- `function_call_output`
- `local_shell_call`
- `reasoning`
- `custom_tool_call`
- `custom_tool_call_output`
- `web_search_call`

### Codex event inventory

- `task_started`
- `turn_started`
- `task_complete`
- `turn_complete`
- `user_message`
- `agent_message`
- `agent_message_delta`
- `token_count`
- `exec_command_begin`
- `exec_command_end`
- `exec_command_output_delta`
- `exec_approval_request`
- `mcp_tool_call_begin`
- `mcp_tool_call_end`
- `error`

## Codex -> Claude

## Top-level rollout lines

### `session_meta`

Native target shape:

- no exact Claude equivalent

Current mapping:

- absorbed into conversion context
- emits Claude `system` sentinel `subtype: 'codex_session_meta'`
- if synthesized by `toCodex`, it is absorbed and not re-emitted

Status:

- `synthesized`

Notes:

- used to set `sessionId`, `cwd`, `gitBranch`, `version`

### `turn_context`

Native target shape:

- no exact Claude equivalent

Current mapping:

- absorbed into conversion context
- emits Claude `system` sentinel `subtype: 'codex_turn_context'`
- synthesized reverse lines are absorbed without output

Status:

- `synthesized`

Missing target-native fields:

- there is no real Claude-native resume object for this

### `compacted`

Native target shape:

- Claude `system` compact boundary

Current mapping:

- maps to `type: 'system'`
- `subtype: 'compact_boundary'`
- `compactMetadata` copied from payload

Status:

- `native`

### `event_msg`

#### `event_msg:exec_approval_request`

Current mapping:

- converted to assistant text summary

Status:

- `summary fallback`

Potential better mapping:

- possibly hidden meta user/system content, but no obvious exact Claude-native equivalent yet

#### `event_msg:task_started` / `task_complete` / other lifecycle events

Current mapping:

- converted to Claude `system` sentinel `subtype: 'codex_event_msg'`

Status:

- `synthesized`

#### `event_msg:thread_name_updated`

Current mapping:

- maps to Claude `custom-title`

Status:

- `native-ish`

Why this is worth doing:

- Codex persists thread renames as a real event
- Claude persists the same concept as session metadata, not chat
- mapping to `custom-title` improves Claude resume/tail metadata more than a
  generic sentinel would

#### `event_msg:user_message`

Current mapping:

- currently not mapped specially in `toClaude`
- generally preserved via nearby `response_item:message`

Status:

- effectively `dropped as native signal`, usually still recoverable via paired response items

Potential improvement:

- use for `queued_command` or prompt-provenance synthesis when useful

#### `event_msg:agent_message`

Current mapping:

- not mapped specially
- generally preserved via paired `response_item:message`

Status:

- effectively `dropped as native signal`, usually recoverable via paired response items

#### `event_msg:agent_message_delta`

Current mapping:

- ignored except for sentinel fallback

Status:

- `dropped` as meaningful native structure

#### `event_msg:exec_command_begin/end/output_delta`

Current mapping:

- ignored except for sentinel fallback

Status:

- `dropped`

Potential improvement:

- could help synthesize richer Claude shell progress / attachments

#### `event_msg:mcp_tool_call_begin/end`

Current mapping:

- ignored except for sentinel fallback

Status:

- `dropped`

Potential improvement:

- could help distinguish MCP-style tool activity from generic custom tools

## Response items

### `response_item:message`

Native target shape:

- Claude `user` or `assistant` message

Current mapping:

- text/refusal content becomes Claude `text` blocks
- `role: user|assistant` preserved
- developer/system Codex messages currently collapse into assistant-ish message handling or are ignored depending on content usage

Status:

- `native` for ordinary user/assistant text

Known gaps:

- Codex message metadata like `phase`, `end_turn` not preserved natively
- developer/system messages are not represented cleanly as Claude-native structures
- Codex user events can also carry richer prompt payload structure such as:
  - `text_elements`
  - `local_images`
  These are not currently translated into Claude `image` / `document` user content.

### `response_item:function_call`

Native target shape:

- Claude assistant `tool_use`

Current mapping:

- if tool is recognized as shell-like:
  - Codex `exec_command` / `write_stdin` -> Claude tool name `Bash`
- otherwise:
  - visible assistant text summary such as `Ran tool ...`

Status:

- `native` for shell-like calls
- `summary fallback` for unsupported Codex tool names

Important stored fields now emitted:

- assistant `tool_use` block id
- mapped tool name
- mapped tool input

Known gaps:

- no native Claude tool mapping yet for many Codex tool names:
  - `apply_patch`
  - `parallel`
  - translator/dev-only tools
  - many MCP/custom tool surfaces

### `response_item:function_call_output`

Native target shape:

- Claude user `tool_result`

Current mapping:

- for mapped shell-like tools:
  - emits `tool_result` block
  - emits top-level `sourceToolAssistantUUID`
  - emits top-level `toolUseResult`
- for unsupported tool names:
  - emits visible user text summary

Status:

- `native` for shell-like tools
- `summary fallback` otherwise

Important improvement:

- Claude resume/render depends heavily on top-level `toolUseResult`, not just the `tool_result` block
- when Codex output includes structured content arrays with Claude-compatible
  item types (`text`, `image`, `document`, `search_result`), the translator now
  preserves them as rich Claude `tool_result.content` instead of flattening
  everything to text

Known gaps:

- `toolUseResult` is only synthesized for the small mapped subset
- output parsing is still heuristic, especially for Codex tool wrapper strings
- image or rich-content outputs are not broadly reconstructed into Claude-native typed tool results except where specifically recognized

### `response_item:custom_tool_call`

Current mapping:

- currently translated as assistant text summary, not a native Claude tool use

Status:

- `summary fallback`

Known gaps:

- no general native mapping from Codex custom tools to Claude tools

### `response_item:custom_tool_call_output`

Current mapping:

- currently translated as user text summary
- special case:
  - `apply_patch` also emits Claude `attachment` entries of type `edited_text_file`

Status:

- `summary fallback`
- plus partial `native attachment synthesis` for edits

Known gaps:

- attachment snippets are placeholder-level, not full Claude-native edit artifacts
- no structured `toolUseResult` for custom tools

### `response_item:reasoning`

Native target shape:

- Claude assistant `thinking`

Current mapping:

- maps to Claude `thinking` block
- preserves Codex reasoning metadata in `block.codex`

Status:

- `native`

### `response_item:local_shell_call`

Native target shape:

- closest practical match is Claude `Bash` tool use

Current mapping:

- translated to Claude assistant `tool_use`
- tool name forced to `Bash`

Status:

- `native-ish`

Known gaps:

- output/result side for local shell call is not directly paired through a dedicated native Claude concept

### `response_item:web_search_call`

Current mapping:

- translated to Claude assistant `tool_use` with synthetic name `web_search`

Status:

- weak `native-ish`

Known gaps:

- likely no real Claude-native tool renderer for this name
- may need summary fallback or attachment strategy instead

## Claude -> Codex

## Top-level Claude entry types

### `user`

Native target shape:

- Codex `event_msg:user_message`
- Codex `response_item:message(role=user)`
- Codex `response_item:function_call_output` for tool-result-only user messages

Current mapping:

- text content:
  - emits both `event_msg:user_message` and `response_item:message`
- `tool_result` blocks:
  - emits `function_call_output` or `custom_tool_call_output`

Status:

- `native` for plain text and direct tool-result blocks

Known gaps:

- Claude top-level user fields mostly not mapped:
  - `permissionMode`
  - `origin`
  - `imagePasteIds`
  - `isMeta`
  - `isVisibleInTranscriptOnly`
  - `sourceToolAssistantUUID`
  - `sourceToolUseID`
  - `toolUseResult`

### `assistant`

Native target shape:

- Codex `event_msg:agent_message`
- Codex `response_item:message(role=assistant)`
- Codex `function_call`
- Codex `reasoning`

Current mapping:

- text blocks:
  - emits both `event_msg:agent_message` and `response_item:message`
- `tool_use` blocks:
  - emits `function_call` or `custom_tool_call`
- `thinking` blocks:
  - emits `reasoning`

Status:

- `native` for text, tool use, and thinking

Known gaps:

- native Codex `local_shell_call` reconstruction currently depends on a recoverable
  command string in the Claude `Bash` input

### `system`

Current mapping:

- compact boundary -> Codex `compacted`
- other system entries dropped unless sidecar restores them

Status:

- `native` only for compact boundary
- otherwise mostly `passthrough`

### `attachment`

Current mapping:

- no native mapping in `toCodex`
- becomes `atp_passthrough`

Status:

- `passthrough`

### `custom-title`

Current mapping:

- emits Codex `event_msg:thread_name_updated`

Status:

- `native-ish`

Why this is worth doing:

- this is the metadata dual of Codex `thread_name_updated`
- Codex persists renames in rollout history, while Claude persists them as
  session metadata lines
- translating directly keeps rename metadata alive in lossy mode

Biggest gap:

- Claude attachments are one of the most important untranslated categories

Important attachment types still unmapped:

- `queued_command`
- `edited_text_file`
- `hook_error_during_execution`
- `command_permissions`
- `structured_output`

Recently mapped intentionally as Codex assistant commentary:

- `edited_text_file`
- `diagnostics`
- `plan_mode`
- `plan_mode_reentry`
- `plan_mode_exit`
- `auto_mode`
- `auto_mode_exit`
- `date_change`
- `mcp_resource`
- `critical_system_reminder`
- `token_usage`
- `budget_usd`
- `output_token_usage`
- `verify_plan_reminder`
- `max_turns_reached`
- `compaction_reminder`
- `context_efficiency`
- `task_status`
- `hook_blocking_error`
- `hook_success` for surfaced Claude events
- `hook_additional_context`
- `hook_stopped_continuation`

Recently mapped as native Codex user state:

- `queued_command`

### `file-history-snapshot`

Current mapping:

- no native Codex mapping
- passthrough only

Status:

- `passthrough`

## Claude-only non-message entry types seen in real transcripts

These currently have no native Codex mapping and rely on passthrough:

- `attachment`
- `file-history-snapshot`
- `last-prompt`
- `permission-mode`
- `queue-operation`
- `attribution-snapshot`
- `mode`
- `worktree-state`
- `content-replacement`

Status:

- mostly `passthrough`

## Media and rich content

### Claude-side native content shapes

From Claude source, user and tool-result content can include more than plain text:

- `image`
- `document`
- notebook-derived content
- PDF-derived content

Relevant observations:

- Claude `FileReadTool` can emit `tool_result.content` arrays containing `image`
- Claude tracks `imagePasteIds` separately at the message level
- Claude uses `document` blocks for PDFs in some paths

Current translator state:

- Codex -> Claude currently treats most ordinary Codex text messages as text only
- Codex -> Claude does not yet intentionally reconstruct:
  - user image prompts
  - user document prompts
  - rich tool-result arrays other than narrow special cases

Status:

- mostly `dropped` or flattened to text

### Codex-side native content shapes

Codex message content is much narrower in the rollout mirror we currently model:

- `input_text`
- `output_text`
- `refusal`

Codex `event_msg:user_message` can also carry:

- `text_elements`
- `local_images`

Current translator state:

- Claude -> Codex does not yet map Claude image/document user content into those richer Codex user-message fields

Status:

- `dropped` as native media structure

## Attachment ordering and placement

Claude has special transcript behavior for attachments:

- attachments bubble up to sit after a stopping point
- stopping points are assistant messages or user tool-result messages

Implication for translation:

- synthesizing Claude attachments is not enough by itself
- they should be emitted in a place that makes sense relative to the associated assistant/tool-result pair

Current translator state:

- `apply_patch` synthesized attachments are emitted immediately after the summary message in the same conversion sweep
- this is directionally correct, but still much simpler than Claude's native attachment-generation pipeline

## Translator-owned metadata

### `_atp`

Purpose:

- preserve source record for byte-identical reverse translation

Origins:

- `claude`
- `codex`
- `synthesized`

Status:

- essential for lossless round-trip
- not sufficient for native resume fidelity on its own

### `block.codex`

Used in Claude-side blocks to preserve Codex-specific metadata:

- function namespace
- custom tool kind
- output metadata
- reasoning ids / encrypted content

Status:

- useful but incomplete

## Best next mapping work

1. Map Claude `attachment` types intentionally instead of treating them as passthrough.
2. Introduce `queued_command` synthesis for relevant Codex prompt/notification shapes.
3. Reconstruct Codex `local_shell_call` from Claude `Bash` when enough structure is present.
4. Decide which unsupported Codex tools deserve:
   - real Claude-native emulation
   - attachment synthesis
   - text summary only
5. Add tests that assert native field presence, not only byte round-trip.

## Concrete implementation backlog

### `toClaude.ts`

1. Keep current shell mapping, but expand result reconstruction beyond plain
   text `toolUseResult` where Codex output content arrays expose richer shapes.
2. Synthesize Claude `attachment.type = 'queued_command'` when Codex prompt or
   notification state is better represented as queued user input than as plain
   text replay.
3. Promote `apply_patch` attachments from placeholder file mentions toward
   Claude-shaped edit attachments where the source Codex payload gives enough
   file context.
4. Decide whether `web_search_call` should remain a weak synthetic tool use or
   be demoted to visible summary text.
5. Use Codex event families more intentionally:
   - `exec_command_begin/end/output_delta`
   - `mcp_tool_call_begin/end`
   - `agent_message_delta`

### `toCodex.ts`

1. Stop treating all Claude attachments as a single passthrough bucket.
2. Add explicit mapping for high-value attachment types:
   - `queued_command`
   - `edited_text_file`
   - `diagnostics`
   - `mcp_resource`
3. Recover native Codex `local_shell_call` from Claude `Bash` whenever the
   tool input is sufficiently structured.
4. Thread more Claude user-message control fields into Codex-native places or
   translator-owned metadata:
   - `origin`
   - `permissionMode`
   - `isMeta`
   - `isVisibleInTranscriptOnly`
   - `imagePasteIds`
5. Preserve more tool/result provenance so a later Codex -> Claude pass can
   restore stronger native Claude linkage without depending entirely on `_atp`.

### Tests to add

1. Claude output contains native top-level `toolUseResult` and
   `sourceToolAssistantUUID` for translated shell results.
2. Claude output contains real `attachment` entries for translated edit cases.
3. Claude -> Codex -> Claude lossy round-trip still preserves:
   - assistant tool uses
   - user tool results
   - queue-ish user prompts where present
4. Codex output preserves both:
   - `event_msg:user_message`
   - `response_item:message(role=user)`
   for the same user turn.

## Quick status summary

Currently strongest mappings:

- Codex text messages <-> Claude text messages
- Codex reasoning <-> Claude thinking
- Codex shell-ish calls/results -> Claude `Bash` tool/result
- Claude compact boundary -> Codex compacted
- Codex thread renames <-> Claude custom titles
- Claude `Bash` <-> Codex `local_shell_call`
- Codex structured tool outputs -> Claude rich tool_result content when the
  block types are Claude-compatible

Currently weakest mappings:

- Claude attachments that are still passthrough-only
- Codex lifecycle events and deltas
- non-shell tool ecosystems
- Claude metadata fields that affect visibility/resume behavior

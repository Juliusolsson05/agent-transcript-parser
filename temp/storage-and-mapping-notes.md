# Storage And Mapping Notes

Working notes from reading `claude-code-src`, `codex-headless`, and `codex-src`.

## Goal

Understand:

1. how Claude and Codex persist transcript JSON/JSONL
2. whether they append or overwrite
3. whether unknown extra fields are tolerated
4. which transcript fields matter for resume fidelity
5. which mappings in `agent-transcript-parser` are still incomplete

## High-level conclusion

Both systems are primarily append-only for transcript persistence, but both also have targeted rewrite or truncate paths.

This means translator-owned reconstruction data can probably live inside the transcript itself, but:

- it must not break native parsing
- it must not violate Claude's fast-path assumptions about transcript message layout
- it should be namespaced and added conservatively

## Claude persistence model

Primary source:

- [claude-code-src/full/utils/sessionStorage.ts](/Users/juliusolsson/Desktop/Development/cc-shell/claude-code-src/full/utils/sessionStorage.ts)
- [claude-code-src/full/utils/json.ts](/Users/juliusolsson/Desktop/Development/cc-shell/claude-code-src/full/utils/json.ts)

### Default write behavior

Claude writes transcript entries as JSONL by appending:

- `jsonStringify(entry) + '\n'`
- batched in `drainWriteQueue`
- appended in `appendToFile`
- low-level append helper also exists in `appendEntryToFile`

Important lines:

- `jsonStringify(entry) + '\n'`
- `appendFileSync(fullPath, line, { mode: 0o600 })`

So the normal transcript behavior is append-only.

### Rewrite / truncate behavior

Claude also rewrites or truncates in several cases:

- tombstoning/removing an entry by uuid
- compaction / snip
- replacing local logs with remote logs
- metadata re-append patterns after compaction or exit

Implication:

- extra translator fields must survive append-only writes
- but also survive occasional parse -> rewrite cycles

### Parser tolerance

Claude JSONL loading is permissive:

- line-by-line `JSON.parse`
- malformed lines are skipped in some paths
- no evidence of strict unknown-field rejection for transcript entries

This makes extra fields viable in principle.

### Critical constraint: byte-level assumptions

Claude has transcript fast paths that assume certain serialized shape details.

Examples from `sessionStorage.ts`:

- transcript messages are expected to serialize with `parentUuid` first
- top-level `uuid` detection depends on specific field ordering and placement
- comments explicitly mention that `toolUseResult` and `mcpMeta` come after top-level `uuid`

Implication:

- adding extra fields is likely safe
- changing key order is risky
- wrapping native fields or moving top-level fields around is risky

## Claude transcript semantics that matter for resume

Primary sources:

- [claude-code-src/full/utils/messages.ts](/Users/juliusolsson/Desktop/Development/cc-shell/claude-code-src/full/utils/messages.ts)
- [claude-code-src/full/utils/conversationRecovery.ts](/Users/juliusolsson/Desktop/Development/cc-shell/claude-code-src/full/utils/conversationRecovery.ts)
- [claude-code-src/full/types/logs.ts](/Users/juliusolsson/Desktop/Development/cc-shell/claude-code-src/full/types/logs.ts)

### Tool result linkage

Real Claude tool-result user entries often contain:

- `message.content[*].type === 'tool_result'`
- `toolUseResult`
- `sourceToolAssistantUUID`

`sourceToolAssistantUUID` is used during transcript insertion to override parent linkage.

`toolUseResult` is important for UI rendering of tool results, because the renderer uses the tool implementation's schema and `renderToolResultMessage`.

Without `toolUseResult`, many tool results resume structurally but render as nothing.

### Attachments are first-class transcript state

Claude stores many non-chat things as `attachment` entries, not inferred from chat text.

Important attachment types include:

- `queued_command`
- `edited_text_file`
- `edited_image_file`
- `hook_success`
- `hook_error_during_execution`
- `plan_mode`
- `plan_mode_exit`
- `auto_mode`
- `auto_mode_exit`
- `diagnostics`
- `mcp_resource`

Attachments are later converted into hidden or visible messages depending on type and flags.

### `queued_command` matters

In `messages.ts`, `attachment.type === 'queued_command'` becomes a `user` message with:

- wrapped text
- optional images
- `origin`
- conditional `isMeta`
- optional `uuid` from `source_uuid`

This is important for resume fidelity. Some Codex events may be better represented as Claude `queued_command` attachments than plain text messages.

### Hidden vs visible messages

Claude uses these fields heavily:

- `isMeta`
- `isVisibleInTranscriptOnly`
- `origin`
- `permissionMode`
- `imagePasteIds`
- `sourceToolUseID`

These affect whether something shows up, how it is counted, and how it is replayed.

Current translator coverage is partial.

## Codex persistence model

Primary sources:

- [codex-src/codex-rs/rollout/src/recorder.rs](/Users/juliusolsson/Desktop/Development/cc-shell/codex-src/codex-rs/rollout/src/recorder.rs)
- [codex-src/codex-rs/protocol/src/protocol.rs](/Users/juliusolsson/Desktop/Development/cc-shell/codex-src/codex-rs/protocol/src/protocol.rs)
- [codex-headless/src/transcript/TranscriptTypes.ts](/Users/juliusolsson/Desktop/Development/cc-shell/codex-headless/src/transcript/TranscriptTypes.ts)

### Default write behavior

Codex rollout persistence is append-based.

`append_rollout_item_to_path`:

- opens with append mode
- serializes one rollout line
- writes newline
- flushes

So native Codex transcript persistence is also append-only by default.

### Rollout line shape

Rust side:

- `RolloutLine { timestamp, #[serde(flatten)] item }`
- `RolloutItem` is tagged as:
  - `session_meta`
  - `response_item`
  - `compacted`
  - `turn_context`
  - `event_msg`

### Parser tolerance

The rollout protocol types do not appear to use `deny_unknown_fields` on rollout items.

`codex-headless` also parses JSONL with plain `JSON.parse` and typed narrowing afterwards.

Implication:

- extra fields on rollout lines are probably tolerated
- `_atp` is already relying on this successfully

## Current translator implications

## What improved already

Recent `Codex -> Claude` improvements:

- shell-like Codex calls now map to Claude `Bash`
- user tool-result entries now include:
  - `sourceToolAssistantUUID`
  - `toolUseResult`
  - `isSidechain`
  - `userType`
  - `entrypoint`
  - `version`
- unsupported Codex tools no longer become invisible unknown tool blocks
- `apply_patch` also emits `attachment` entries of type `edited_text_file`

This made Claude resume materially better.

## What is still incomplete

### Claude-side gaps

`toClaude` still does not map many Claude-native transcript fields or entry types cleanly:

- `queued_command`
- `permissionMode`
- `origin`
- `imagePasteIds`
- `isMeta`
- `isVisibleInTranscriptOnly`
- `sourceToolUseID`
- `file-history-snapshot`
- `queue-operation`
- `last-prompt`

### Codex-side gaps

`toCodex` still flattens or drops a lot:

- Claude attachments become `atp_passthrough` instead of native Codex items
- Claude `Bash` currently returns to generic `function_call` unless codex-specific metadata is preserved
- Claude-only structural metadata is mostly passthrough, not native mapping

### Turn context fidelity

Codex `turn_context` natively supports more than we currently synthesize:

- `timezone`
- `sandbox_policy.writable_roots`
- `sandbox_policy.network_access`
- `network`
- `model`
- `personality`
- `collaboration_mode`
- `effort`
- `summary`
- `user_instructions`
- `developer_instructions`
- `truncation_policy`

We currently synthesize only a small subset.

### Event fidelity

Codex has native event types we barely use in translation:

- `exec_command_begin`
- `exec_command_end`
- `exec_command_output_delta`
- `mcp_tool_call_begin`
- `mcp_tool_call_end`
- `agent_message_delta`

These may matter for better replay/resume behavior and should be inventoried explicitly.

## Recommendation on storing translator-only data

Likely safe:

- keep using a namespaced translator field like `_atp`
- add more translator-owned data only after native top-level fields
- do not reorder Claude's native transcript keys
- do not replace native shapes with wrapped custom objects

Prefer:

- native field whenever Claude or Codex already has one
- translator-owned fallback only when there is no native equivalent

For Claude specifically:

- if we need extra reconstruction data, attach it late in the object
- keep `parentUuid`, `uuid`, `timestamp`, `type`, `message` in a Claude-like order

## Suggested next work

1. Build a mapping ledger for every Claude entry / attachment type and every Codex rollout type.
2. Explicitly mark each mapping as:
   - native
   - synthesized
   - summary fallback
   - passthrough only
   - dropped
3. Implement `queued_command` mapping for relevant Codex prompt/notification shapes.
4. Audit whether more Codex shell activity should map to native `local_shell_call` instead of generic tool calls on the reverse path.
5. Add tests that assert presence of the top-level Claude fields resume depends on, not just round-trip byte equality.

## Files worth rereading

- [claude-code-src/full/utils/sessionStorage.ts](/Users/juliusolsson/Desktop/Development/cc-shell/claude-code-src/full/utils/sessionStorage.ts)
- [claude-code-src/full/utils/messages.ts](/Users/juliusolsson/Desktop/Development/cc-shell/claude-code-src/full/utils/messages.ts)
- [claude-code-src/full/utils/conversationRecovery.ts](/Users/juliusolsson/Desktop/Development/cc-shell/claude-code-src/full/utils/conversationRecovery.ts)
- [claude-code-src/full/types/logs.ts](/Users/juliusolsson/Desktop/Development/cc-shell/claude-code-src/full/types/logs.ts)
- [codex-src/codex-rs/protocol/src/protocol.rs](/Users/juliusolsson/Desktop/Development/cc-shell/codex-src/codex-rs/protocol/src/protocol.rs)
- [codex-src/codex-rs/rollout/src/recorder.rs](/Users/juliusolsson/Desktop/Development/cc-shell/codex-src/codex-rs/rollout/src/recorder.rs)
- [codex-headless/src/transcript/TranscriptTypes.ts](/Users/juliusolsson/Desktop/Development/cc-shell/codex-headless/src/transcript/TranscriptTypes.ts)

// Rewind a Codex rollout to "just before" a selected user prompt.
//
// Produces a new rollout file content that retains every line strictly
// BEFORE the anchored user `response_item` message and drops the
// anchor plus everything after. A fresh `session_meta.payload.id`
// stamps the retained lines so the new file can coexist with the
// source under `~/.codex/sessions/...` without collision.
//
// Codex's on-disk shape:
//   - Line 0 is `session_meta` (payload carries `id` + `timestamp`).
//   - Subsequent lines are `turn_context`, `response_item`,
//     `event_msg`, `compacted`, or forward-compatible types.
//   - User prompts live on `response_item` lines of payload
//     `type === 'message'` / `role === 'user'`.
//
// The anchor is identified by its position among user-message
// response_items (i.e. "the N-th user prompt in document order").
// Matching by payload `id` is unreliable: Codex's replay/resume
// flow re-emits message ids from the previous session, so the
// same id can appear on multiple lines. Position ordering is what
// the renderer's picker sees, so it is also what we match on.
//
// The returned `promptText` is the text content of the anchored
// message. Agent Code puts it into `draftInput`; it is intentionally
// NOT present in the output lines.
//
// WHY a dedicated entry-point instead of reusing cloneCodexRollout:
//
//   1. Cloning preserves the full rollout; rewind needs the prefix.
//      Splicing a "truncate here" mode into cloneCodexRollout would
//      blur its contract.
//   2. Codex's resume path rejects a rollout whose trailing
//      `function_call`/`custom_tool_call` has no paired
//      `function_call_output`/`custom_tool_call_output`. Rewind can
//      easily produce that shape if the anchor lands between a tool
//      call and its output; cloning never does.
//   3. Mutation-bearing `event_msg` kinds (`thread_rolled_back`,
//      `turn_aborted`, `context_compacted`) are idempotent-unsafe:
//      resume applies them again on load, which jumps the user back
//      from where we just landed. `switchProvider` already strips
//      these via `sanitizeForResume: true`; rewind needs the same
//      treatment so the user lands at the prompt they chose instead
//      of some earlier point codex then rewinds them to.
//
// Filesystem IO (deciding the on-disk path, writing the file) lives
// in `src/main/providerSwitch/rewindSession.ts` so this file stays
// browser-buildable.

import { randomUUID } from 'node:crypto'

import type { CodexRolloutLine } from './types.js'

export type RewindCodexAnchor = {
  /** Zero-based index among user-role `response_item` messages in
   *  document order. anchor=0 drops at the first user message, so
   *  the rewound rollout contains ONLY the session_meta + bootstrap
   *  pre-prompt lines. */
  userMessageIndex: number
}

export type RewindCodexOptions = {
  /** New session id. If omitted a fresh UUID v4 is generated. */
  newSessionId?: string
  /** New `session_meta.payload.timestamp` (ISO-8601). Defaults to
   *  now so the new rollout filename doesn't collide with the source
   *  inside the same day-bucketed directory. */
  newTimestamp?: string
}

export type RewindCodexResult = {
  lines: CodexRolloutLine[]
  newSessionId: string
  newTimestamp: string
  /** Text of the anchored user message, extracted from the source.
   *  The caller stuffs this into `draftInput`; it is NOT present in
   *  `lines`. */
  promptText: string
  /** Position of the anchored line in the source rollout. Debug
   *  convenience; callers typically ignore this. */
  anchorLineIndex: number
}

export class RewindCodexAnchorNotFoundError extends Error {
  constructor(anchor: RewindCodexAnchor, totalUserMessages: number) {
    super(
      `Codex rewind anchor userMessageIndex=${anchor.userMessageIndex} is out of range — rollout has ${totalUserMessages} user message(s).`,
    )
    this.name = 'RewindCodexAnchorNotFoundError'
  }
}

export class RewindCodexMissingSessionMetaError extends Error {
  constructor() {
    super('Codex rollout rewind requires a session_meta line in the source.')
    this.name = 'RewindCodexMissingSessionMetaError'
  }
}

// event_msg payload types that mutate history on replay. These are
// one-shot signals codex writes on `/rollback`, aborted turns, and
// compaction. Including them in a resumed rollout causes codex-rs
// to re-apply the mutation, which is exactly the jumping-backwards
// symptom we want to avoid. Same list as switchProvider's
// `sanitizeForResume: true` option.
const MUTATING_EVENT_MSG_TYPES = new Set([
  'thread_rolled_back',
  'turn_aborted',
  'context_compacted',
])

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function rewindCodexRollout(
  source: readonly CodexRolloutLine[],
  anchor: RewindCodexAnchor,
  options: RewindCodexOptions = {},
): RewindCodexResult {
  const newSessionId = options.newSessionId ?? randomUUID()
  const newTimestamp = options.newTimestamp ?? new Date().toISOString()

  // ---------------------------------------------------------------------
  // Find the anchor line.
  //
  // We scan in order, counting user-role message response_items.
  // The N-th match (zero-based) is the anchor; everything at that
  // line index and later is dropped.
  //
  // Codex's rollout CAN carry multiple user `response_item` messages
  // per logical turn (a turn with an attached file prompt + text
  // shows up as two user messages). The renderer's picker collapses
  // those into one visible prompt, so the N-th picker prompt may
  // correspond to a sub-range in the rollout. We err on the safe
  // side here and match 1:1 against the raw response_item stream;
  // the renderer must supply the same index. `mapCodexRolloutToFeedEntries`
  // already normalizes order deterministically, so the index the
  // picker produces is stable.
  // ---------------------------------------------------------------------
  let userMessageCount = 0
  let anchorLineIndex = -1
  let promptText = ''
  for (let i = 0; i < source.length; i++) {
    const line = source[i]
    if (!line) continue
    if (!isUserMessageLine(line)) continue
    if (userMessageCount === anchor.userMessageIndex) {
      anchorLineIndex = i
      promptText = extractUserPromptText(line)
      break
    }
    userMessageCount++
  }
  if (anchorLineIndex < 0) {
    // Count the rest for a better error message.
    let total = userMessageCount
    for (let i = 0; i < source.length; i++) {
      const line = source[i]
      if (line && isUserMessageLine(line)) total++
    }
    throw new RewindCodexAnchorNotFoundError(anchor, total)
  }

  // ---------------------------------------------------------------------
  // Truncate.
  // ---------------------------------------------------------------------
  const retained = source.slice(0, anchorLineIndex)

  // ---------------------------------------------------------------------
  // Require a session_meta line and stamp it with the new id + ts.
  // ---------------------------------------------------------------------
  const sessionMetaIndex = retained.findIndex(line => line.type === 'session_meta')
  if (sessionMetaIndex < 0) {
    throw new RewindCodexMissingSessionMetaError()
  }

  // ---------------------------------------------------------------------
  // Drop orphan tool calls.
  //
  // For any `function_call` / `custom_tool_call` / `local_shell_call`
  // in the retained slice, check whether a matching
  // `function_call_output` / `custom_tool_call_output` exists later
  // in the retained slice. Orphan tool calls are dropped so codex's
  // resume loader accepts the file.
  //
  // We match on `call_id` which is the canonical pairing key in
  // Codex's rollout format.
  // ---------------------------------------------------------------------
  const resolvedCallIds = collectResolvedCallIds(retained)

  // ---------------------------------------------------------------------
  // Assemble the output line list, applying every filter in one pass.
  //
  // Rules, in order:
  //   1. session_meta   — rewrite id + timestamp.
  //   2. event_msg with mutating type — drop.
  //   3. response_item with orphan tool call — drop.
  //   4. trailing reasoning-only tail — drop (see below).
  //   5. everything else — retain verbatim.
  //
  // Trailing reasoning: Codex emits `reasoning` response_items before
  // an assistant `message`; if the anchor lands between them, the
  // retained slice has a dangling reasoning chain. Resume works but
  // the next turn sometimes continues that reasoning instead of
  // responding to the user's new prompt. We drop trailing reasoning
  // items that have no `message` after them.
  // ---------------------------------------------------------------------
  const lines: CodexRolloutLine[] = []
  for (let i = 0; i < retained.length; i++) {
    const line = retained[i]
    if (!line) continue

    if (line.type === 'session_meta') {
      lines.push(rewriteSessionMeta(line, newSessionId, newTimestamp))
      continue
    }

    if (line.type === 'event_msg') {
      const evType = asRecord(line.payload)?.type
      if (typeof evType === 'string' && MUTATING_EVENT_MSG_TYPES.has(evType)) {
        continue
      }
    }

    if (line.type === 'response_item') {
      const payload = asRecord(line.payload)
      if (
        payload &&
        (payload.type === 'function_call' ||
          payload.type === 'custom_tool_call' ||
          payload.type === 'local_shell_call') &&
        typeof payload.call_id === 'string' &&
        !resolvedCallIds.has(payload.call_id)
      ) {
        continue
      }
    }

    lines.push(line)
  }

  // Drop trailing reasoning items (walk backwards, stop at first
  // non-reasoning response_item or any event_msg/turn_context).
  while (lines.length > 0) {
    const last = lines.at(-1)
    if (!last) break
    if (last.type === 'response_item') {
      const payload = asRecord(last.payload)
      if (payload?.type === 'reasoning') {
        lines.pop()
        continue
      }
    }
    break
  }

  return {
    lines,
    newSessionId,
    newTimestamp,
    promptText,
    anchorLineIndex,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isUserMessageLine(line: CodexRolloutLine): boolean {
  if (line.type !== 'response_item') return false
  const payload = asRecord(line.payload)
  return payload?.type === 'message' && payload.role === 'user'
}

function extractUserPromptText(line: CodexRolloutLine): string {
  const payload = asRecord(line.payload)
  if (payload?.type !== 'message') return ''
  if (!Array.isArray(payload.content)) return ''
  const parts: string[] = []
  for (const block of payload.content) {
    const record = asRecord(block)
    if (record?.type === 'input_text' && typeof record.text === 'string') {
      parts.push(record.text)
    }
  }
  return parts.join('\n')
}

function rewriteSessionMeta(
  line: CodexRolloutLine,
  newSessionId: string,
  newTimestamp: string,
): CodexRolloutLine {
  // Cast: `session_meta` payload shape is pinned in types.ts; at
  // runtime we only rewrite two fields on the payload and the
  // top-level timestamp. Everything else is preserved.
  const payload = { ...line.payload, id: newSessionId, timestamp: newTimestamp }
  return {
    ...line,
    timestamp: newTimestamp,
    payload,
  } as CodexRolloutLine
}

function collectResolvedCallIds(
  retained: readonly CodexRolloutLine[],
): Set<string> {
  const resolved = new Set<string>()
  for (const line of retained) {
    if (line.type !== 'response_item') continue
    const payload = asRecord(line.payload)
    if (
      payload &&
      (payload.type === 'function_call_output' ||
        payload.type === 'custom_tool_call_output' ||
        payload.type === 'tool_search_output') &&
      typeof payload.call_id === 'string'
    ) {
      resolved.add(payload.call_id)
    }
  }
  return resolved
}

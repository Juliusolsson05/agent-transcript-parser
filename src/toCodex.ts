// Claude conversation entries → Codex rollout lines.
//
// Short-circuits on `_atp.origin === 'codex'` for byte-identical
// round-trip when the input was previously converted from Codex.
// Otherwise walks each Claude entry's content blocks and emits one
// Codex line per tool/text/thinking block (Claude's single multi-
// block turn becomes multiple Codex response_items — matching
// Codex's stream-oriented format).
//
// Prepends a synthesized `session_meta` line before the first
// non-system entry so downstream Codex consumers see a valid stream.
// That session_meta is NOT sidecar-attached because it has no
// original source to point back to.

import { attachSidecar, readSidecar } from './sidecar.js'
import type { ConvertOptions } from './toClaude.js'
import { randomUUID } from 'node:crypto'
import { stableUuid } from './util.js'
import type {
  ClaudeContentBlock,
  ClaudeEntry,
  ClaudeThinkingBlock,
  ClaudeToolResultBlock,
  ClaudeToolUseBlock,
  CodexContentItem,
  CodexRolloutLine,
} from './types.js'

export type { ConvertOptions } from './toClaude.js'

export function toCodex(
  entries: readonly ClaudeEntry[],
  opts: ConvertOptions = {},
): CodexRolloutLine[] {
  const lossy = opts.lossy === true
  // Provider-switch in Agent Code (Claude → Codex) turns this on so the
  // translated rollout does not inherit Claude's self-injected bootstrap
  // burst (tool list, MCP instructions, skill listing, todo reminders).
  // Those entries are Claude-local housekeeping; Codex has its own
  // equivalents and leaking them poisons the target conversation with
  // a giant commentary block on resume. Default stays off so existing
  // round-trip fidelity tests keep passing byte-for-byte.
  const dropClaudeBootstrap = opts.dropClaudeBootstrap === true
  // Provider-switch in Agent Code (Claude → Codex) turns this on so that
  // codex-origin sidecars carrying one-shot history mutations
  // (thread_rolled_back, turn_aborted, compacted with a stale
  // replacement_history) are stripped before emission. Without this,
  // codex's resume re-applies those mutations on every provider switch,
  // producing the "jumped back N messages" class of bug. Default stays
  // off because fixtures in this package verify byte-identical
  // Codex→Claude→Codex round-trip, which requires the sidecar contents
  // to flow through untouched.
  const sanitizeForResume = opts.sanitizeForResume === true
  // Reusing the source Claude session id as the target Codex thread id
  // looks convenient, but it causes real collisions during resume
  // testing: multiple imported rollout files with the same id can
  // coexist under ~/.codex/sessions and Codex's state/indexing path
  // does not reliably treat "new file, same id" as a clean replace.
  //
  // A fresh target id per export keeps each imported Codex session
  // isolated. Callers that genuinely need a fixed id can still pass
  // one explicitly.
  const targetSessionId = opts.targetSessionId ?? randomUUID()
  const out: CodexRolloutLine[] = []

  let sessionMetaEmitted = false
  const seenSourceKeys = new Set<string>()

  // Turn-boundary state. Codex's replay pipeline (see
  // codex-rs/app-server-protocol/src/protocol/thread_history.rs)
  // groups events into explicit turns via task_started + turn_context
  // + task_complete event triplets. Without these, events pile into a
  // single implicit turn that Codex's TUI doesn't render past some
  // internal limit — we empirically hit this with a 2700-line
  // translated Claude transcript: user messages rendered, agent
  // messages didn't. Wrapping each user-entry-and-its-responses in
  // explicit turn boundaries makes the replay pipeline build a
  // sequence of smaller turns that all render cleanly.
  // Helper: wrap a CodexRolloutLine as synthesized (emitted by the
  // converter, not derived from any source Claude entry). toClaude
  // already absorbs synthesized session_meta / turn_context into
  // context without emitting entries; we extend the same treatment
  // to the turn-boundary event_msgs so Claude→Codex→Claude round-trip
  // doesn't gain phantom codex_event_msg sentinel entries.
  const markSynth = (line: CodexRolloutLine): CodexRolloutLine =>
    lossy ? line : ({ ...line, _atp: { origin: 'synthesized' } } as CodexRolloutLine)

  let openTurn: { id: string; lastAgentMessage: string } | null = null
  const closeTurn = (timestamp: string) => {
    if (!openTurn) return
    out.push(markSynth({
      timestamp,
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: openTurn.id,
        last_agent_message: openTurn.lastAgentMessage,
      },
    }))
    openTurn = null
  }

  // Accumulated cwd from the most recent entry that had one — used
  // to populate turn_context.cwd when the emitting entry lacks it.
  let turnCwd = ''

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!
    // Bootstrap-filter MUST run before the sidecar short-circuit. A Claude
    // user entry with isMeta: true that was *originally* sourced from a
    // Codex line would have origin: 'codex' — we don't want to drop that,
    // because the user's real Codex content shouldn't disappear. Conversely,
    // a Claude-injected reminder has either no sidecar or origin: 'claude',
    // and that's exactly what we want to strip. The predicate checks both
    // the entry shape AND the sidecar origin so we only drop things that
    // were invented by Claude on the way in.
    if (dropClaudeBootstrap && isClaudeBootstrapEntry(entry)) {
      continue
    }
    const sidecar = readSidecar(entry)
    // Ghost entry — a provisional record emitted by a live layer
    // (see `./ghost.ts` and `docs/ghost.md`). Ghosts are a runtime
    // artifact; they must NOT land in a durable Codex rollout.
    // Skip silently before any further processing (no session_meta
    // synthesis, no turn wrapping, no cwd tracking) so the export
    // looks the same as if the ghost had never been present.
    if (sidecar?.origin === 'ghost') {
      continue
    }
    if (sidecar?.origin === 'codex') {
      // toClaude's coalesce post-pass can turn `source` into an array
      // when it merges multiple Codex response_items into one Claude
      // entry (e.g. N parallel function_calls collapsed into one
      // assistant with N tool_use blocks). Iterate uniformly so both
      // single and array shapes emit the original stream.
      const sources: CodexRolloutLine[] = Array.isArray(sidecar.source)
        ? (sidecar.source as CodexRolloutLine[])
        : [sidecar.source as CodexRolloutLine]
      for (const source of sources) {
        // When `sanitizeForResume` is on, strip one-shot history
        // mutations before re-emitting. The original session already
        // applied these; codex's resume would re-apply them on every
        // provider switch, producing the "jumped back N messages" bug
        // we observed in Agent Code. See sanitizeCodexSourceForReplay for
        // the full rationale. When off, re-emit verbatim to keep
        // Codex→Claude→Codex byte-identical (checked by package
        // fixtures).
        const emitted = sanitizeForResume
          ? sanitizeCodexSourceForReplay(source)
          : source
        if (!emitted) continue
        const sourceKey = JSON.stringify(emitted)
        if (seenSourceKeys.has(sourceKey)) continue
        seenSourceKeys.add(sourceKey)
        out.push(emitted)
        if (emitted.type === 'session_meta') sessionMetaEmitted = true
        const sourceCwd = codexLineCwd(emitted)
        if (sourceCwd) turnCwd = sourceCwd
      }
      continue
    }

    if (!sessionMetaEmitted && entry.type !== 'system') {
      const synth = synthesizeSessionMeta(
        entry,
        entries,
        lossy,
        targetSessionId,
      )
      if (synth) {
        out.push(synth)
        sessionMetaEmitted = true
      }
    }
    if (entry.cwd) turnCwd = entry.cwd

    // Claude encodes what Codex calls a `CompactedItem` as TWO entries:
    // a `system {subtype: compact_boundary}` fence followed immediately
    // by the `user {isCompactSummary: true}` carrying the summary text
    // (see buildPostCompactMessages in claude-code-src/full/services/
    // compact/compact.ts). Codex's reconstruction, in contrast, stores
    // it as ONE native rollout line whose `replacement_history` replaces
    // everything before it on resume (see rollout_reconstruction.rs:250
    // — `history.replace(replacement_history.clone())`).
    //
    // To make Codex genuinely recognize a Claude-origin session as
    // compacted (and therefore truncate the pre-compact history on
    // resume instead of consuming it whole), we coalesce the two
    // Claude entries here into a single `compacted` Codex line.
    //
    // Sidecar carries BOTH source entries so the reverse trip
    // (toClaude) re-emits them verbatim via the short-circuit path,
    // preserving Claude→Codex→Claude byte-equality.
    if (
      entry.type === 'system' &&
      entry.subtype === 'compact_boundary'
    ) {
      const summaryEntry = entries[i + 1]
      if (summaryEntry && isClaudeCompactSummaryEntry(summaryEntry)) {
        // Compaction is a history fence — close any open turn before the
        // fence so Codex's turn reconstruction doesn't merge the pre- and
        // post-compact sides into one logical turn.
        closeTurn(entry.timestamp)
        // Codex-origin boundaries carry the original payload verbatim in
        // `compactMetadata` (see mapCompacted in toClaude). When present,
        // prefer it so lossy Codex→Claude→Codex preserves fields like
        // `replacement_history` exactly rather than degenerating to our
        // minimal summary-only shape.
        const preserved = extractCodexCompactedPayload(entry)
        let payload: Record<string, unknown>
        if (preserved) {
          payload = preserved
        } else {
          const rawSummary = extractClaudeSummaryText(summaryEntry)
          // Prepend Codex's SUMMARY_PREFIX so Codex's `is_summary_message`
          // check (core/src/compact.rs:271) recognizes the injected item
          // as a summary rather than a normal user message. Without the
          // prefix the legacy-path reconstruction that falls back to
          // `build_compacted_history` would double-count the summary
          // among the kept user messages.
          const summaryForCodex = rawSummary.startsWith(`${CODEX_SUMMARY_PREFIX}\n`)
            ? rawSummary
            : `${CODEX_SUMMARY_PREFIX}\n${rawSummary}`
          payload = {
            message: summaryForCodex,
            // Minimal replacement_history: a single user InputText item
            // carrying the summary. This matches what Codex itself
            // writes in the "summary only" case — see
            // core/src/compact.rs:383 where the last push is a
            // role:"user" InputText with the summary text. Preserved
            // pre-compact messages (if Claude recorded a
            // `preservedSegment`) are carried across as ordinary
            // post-boundary entries in the source stream, so they end
            // up AFTER this `compacted` line in the Codex output —
            // which is exactly where Codex's reconstruction appends
            // post-compact items anyway.
            replacement_history: [
              {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: summaryForCodex }],
              },
            ],
          }
        }
        const compactedLine: CodexRolloutLine = {
          timestamp: entry.timestamp,
          type: 'compacted',
          payload,
        }
        const decorated: CodexRolloutLine = lossy
          ? compactedLine
          : ({
              ...compactedLine,
              _atp: {
                origin: 'claude',
                source: [entry, summaryEntry],
              },
            } as CodexRolloutLine)
        out.push(decorated)
        // Skip the summary entry — it was consumed into the compacted line.
        i++
        continue
      }
      // Boundary without an adjacent summary: fall through to the
      // existing `mapSystemEntry` path, which drops it. A pure
      // boundary alone carries no information Codex can act on.
    }

    // Start a new turn on every user entry that carries text
    // content. Tool-result-only user entries don't qualify — they're
    // the assistant's tool-output replies, not a new user prompt.
    const startsNewTurn = entryStartsNewTurn(entry)
    if (startsNewTurn) {
      closeTurn(entry.timestamp)
      openTurn = {
        id: stableUuid([entry.sessionId ?? '', entry.uuid ?? '', 'turn']),
        lastAgentMessage: '',
      }
      const parsedStartedAt = Date.parse(entry.timestamp)
      out.push(markSynth({
        timestamp: entry.timestamp,
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: openTurn.id,
          ...(Number.isFinite(parsedStartedAt)
            ? { started_at: Math.floor(parsedStartedAt / 1000) }
            : {}),
          model_context_window: 272000,
          collaboration_mode_kind: 'default',
        },
      }))
      out.push(markSynth({
        timestamp: entry.timestamp,
        type: 'turn_context',
        payload: {
          turn_id: openTurn.id,
          cwd: turnCwd,
          current_date: entry.timestamp.slice(0, 10),
          approval_policy: 'on-request',
          sandbox_policy: { type: 'workspace-write' },
          model: 'gpt-5',
          personality: 'pragmatic',
          // `summary` is a REQUIRED field on TurnContextItem (see
          // codex-rs/protocol/src/protocol.rs:2810). Omitting it makes
          // codex's load_rollout_items silently fail to deserialize the
          // line (counted in parse_errors, then skipped). Response
          // items still replay so conversation content is intact, but
          // codex loses the per-turn metadata used by
          // reconstruct_history_from_rollout's reverse scan to finalize
          // segments and anchor resume state. 'auto' matches codex's
          // own default in fresh sessions — any valid variant works;
          // 'auto' is the safest pick because it surrenders the choice
          // back to codex's configured default on resume.
          summary: 'auto',
        },
      }))
    }

    const lines = mapEntry(entry)
    for (const line of lines) {
      const decorated = lossy ? line : attachSidecar(line, 'claude', entry)
      out.push(decorated as CodexRolloutLine)
      // Capture the most recent agent_message text to feed into the
      // eventual task_complete.last_agent_message — Codex uses this
      // for the "last assistant reply" preview shown next to the
      // session in the resume picker and elsewhere.
      if (
        openTurn &&
        line.type === 'event_msg' &&
        (line.payload as { type?: string }).type === 'agent_message'
      ) {
        const msg = (line.payload as { message?: string }).message
        if (typeof msg === 'string') openTurn.lastAgentMessage = msg
      }
    }
  }

  // Close trailing turn at the end of the stream.
  if (openTurn) {
    const lastTs = entries.length > 0
      ? (entries[entries.length - 1]?.timestamp ?? new Date().toISOString())
      : new Date().toISOString()
    closeTurn(lastTs)
  }

  return out
}

/**
 * Does a Claude user entry carry any text content that represents a
 * real user prompt (not just tool_result blocks)? Used to decide
 * whether to open a new Codex turn.
 */
function userEntryHasText(entry: ClaudeEntry): boolean {
  const content = entry.message?.content
  if (typeof content === 'string') return content.trim().length > 0
  if (!Array.isArray(content)) return false
  return content.some(
    b => (b as { type?: string }).type === 'text' &&
      typeof (b as { text?: string }).text === 'string' &&
      (b as { text: string }).text.trim().length > 0,
  )
}

// ---------------------------------------------------------------------------
// session_meta synthesis
// ---------------------------------------------------------------------------

function synthesizeSessionMeta(
  entry: ClaudeEntry,
  allEntries: readonly ClaudeEntry[],
  lossy: boolean,
  targetSessionId: string,
): CodexRolloutLine | null {
  // Codex's `codex resume` command rejects session_meta lines that
  // are missing required fields. Walk all entries to find populated
  // cwd / gitBranch / timestamp — the FIRST entry might be a
  // synthetic system entry (permission-mode, attachment, etc.) with
  // none of these set, but a later real conversation entry will
  // have them.
  const cwd = firstNonEmpty(allEntries, e => e.cwd) ?? ''
  const gitBranch = firstNonEmpty(allEntries, e => e.gitBranch)
  const timestamp =
    firstNonEmpty(allEntries, e => e.timestamp) ?? new Date().toISOString()

  const line: CodexRolloutLine = {
    timestamp,
    type: 'session_meta',
    payload: {
      id: targetSessionId,
      timestamp,
      cwd,
      // Stamp originator so a Codex viewer can tell this rollout
      // came from a translator, not the Codex CLI itself. The
      // `originator` field is an arbitrary string, so we're free
      // to use our own brand.
      originator: 'agent-transcript-parser',
      cli_version: '0.1.0',
      // `source` must be one of Codex's known SessionSource enum
      // values (cli, vscode, exec, mcp). Using `"cli"` is the
      // safest pick — Codex's list/discovery treats it as a
      // normal interactive session. Arbitrary strings deserialize
      // via #[serde(other)] on newer Codex versions, but older
      // versions reject the whole file.
      source: 'cli',
      // `model_provider` is required for resume discovery: the
      // picker filters by `model_provider IN (...)` using the
      // user's default provider (typically "openai"). An empty or
      // mismatched value means the row is filtered out of the
      // picker even when every other field is correct. "openai"
      // is the near-universal default for Codex users.
      model_provider: 'openai',
      ...(gitBranch ? { git: { branch: gitBranch } } : { git: {} }),
    },
  }
  // In fidelity mode, mark this as synthesized so toClaude can absorb
  // it into context without emitting a sentinel entry — preserves the
  // Claude→Codex→Claude byte-equality invariant.
  if (lossy) return line
  return { ...line, _atp: { origin: 'synthesized' } } as CodexRolloutLine
}

function firstNonEmpty<T>(
  items: readonly ClaudeEntry[],
  pick: (e: ClaudeEntry) => T | undefined,
): T | undefined {
  for (const item of items) {
    const v = pick(item)
    if (v !== undefined && v !== '') return v
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Per-entry dispatcher
// ---------------------------------------------------------------------------

function mapEntry(entry: ClaudeEntry): CodexRolloutLine[] {
  if (entry.type === 'user') return mapUserEntry(entry)
  if (entry.type === 'assistant') return mapAssistantEntry(entry)
  if (entry.type === 'system') return mapSystemEntry(entry)
  if (entry.type === 'attachment') return mapAttachmentEntry(entry)
  if (entry.type === 'custom-title') return mapCustomTitleEntry(entry)
  // Unknown Claude entry types (permission-mode, file-history-snapshot,
  // attachment, last-prompt, queue-operation, progress, etc.) have no
  // native Codex form. Emit a passthrough line that carries the entry
  // as sidecar so the Claude→Codex→Claude round-trip can restore it
  // via short-circuit. The passthrough type ('atp_passthrough') is
  // outside Codex's known type enum — codex-headless treats it as
  // an unknown line and ignores it, so it doesn't pollute Codex's
  // own consumers either.
  return [
    {
      timestamp: entry.timestamp ?? new Date().toISOString(),
      type: 'atp_passthrough',
      payload: { source_type: entry.type },
    },
  ]
}

/**
 * True for Claude entries that are self-injected housekeeping — the
 * "fat system-reminder" the user sees on every session boot / toolset
 * change. These are NOT user prompts and NOT assistant output; they are
 * Claude's own bootstrap context. Leaving them in a Codex rollout on
 * provider switch creates a giant commentary turn that the resumed
 * Codex agent then reads as if the user pasted it.
 *
 * The filter intentionally stays narrow:
 *
 *   - `type: 'user'` + `isMeta: true` with ONLY text content: this is how
 *     Claude stores the system-reminder block (tool list, MCP
 *     instructions, skill bootstrap, Todoist notes, etc.). Any
 *     `tool_result` inside the content disqualifies it — tool results
 *     can be authored by Claude but carry real work state we must keep.
 *
 *   - `type: 'attachment'` with an attachment.type from the
 *     housekeeping families (deferred tools, skill listing, todo/task
 *     reminders, capability/MCP deltas, output-style/ultrathink mode
 *     toggles, agent mentions). Attachments that could carry real
 *     content the user cares about (`mcp_resource`, `invoked_skills`,
 *     `plan_file_reference`, `edited_text_file`, `diagnostics`,
 *     `queued_command`, `critical_system_reminder`, etc.) are left
 *     alone.
 *
 *   - Any entry whose sidecar origin is `codex` is left alone even if
 *     it looks bootstrap-shaped — that's a user's real Codex content
 *     that happened to round-trip through Claude.
 *
 * Conservatism matters: false positives silently delete user content.
 * The safer default is to leave anything ambiguous as a visible
 * commentary block; callers who opt in already accept a little leftover
 * Claude chatter over any chance of dropping real conversation.
 */
function isClaudeBootstrapEntry(entry: ClaudeEntry): boolean {
  const sidecar = readSidecar(entry)
  if (sidecar?.origin === 'codex') return false

  if (entry.type === 'user' && entry.isMeta === true && entry.message) {
    const content = entry.message.content
    if (typeof content === 'string') {
      // Meta user entries in stringified form still only carry reminder
      // text in the wild; drop them too. If we later find a meta user
      // message whose string content is meaningful we'll revisit.
      return true
    }
    if (Array.isArray(content)) {
      // If anything in the content array is NOT a plain text block,
      // keep the entry. tool_result blocks are the canonical "this is
      // real work state" case, but we also guard against future block
      // types by requiring every block to be text.
      return content.every(
        block => isRecord(block) && block.type === 'text',
      )
    }
  }

  if (entry.type === 'attachment') {
    const attachment = entry.attachment
    if (!attachment || typeof attachment.type !== 'string') return false
    switch (attachment.type) {
      case 'deferred_tools_delta':
      case 'skill_listing':
      case 'todo_reminder':
      case 'task_reminder':
      case 'agent_listing_delta':
      case 'mcp_instructions_delta':
      case 'agent_mention':
      case 'output_style':
      case 'ultrathink_effort':
        return true
      default:
        return false
    }
  }

  return false
}

// ---------------------------------------------------------------------------
// Compaction helpers (Claude → Codex)
// ---------------------------------------------------------------------------

/**
 * Codex's on-disk summary prefix. Kept in sync with
 * codex-src/codex-rs/core/templates/compact/summary_prefix.md. Codex
 * prepends this verbatim to the summary text before writing it to the
 * rollout's `CompactedItem.message`. Its `is_summary_message` check
 * (core/src/compact.rs:271) tests for exactly this string + "\n" as a
 * prefix when distinguishing summary user-messages from real ones in
 * the legacy reconstruction path. We mirror the constant locally so
 * we don't take a runtime dep on the Codex source tree.
 */
const CODEX_SUMMARY_PREFIX =
  'Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:'

/**
 * Claude wraps the raw summary text inside `getCompactUserSummaryMessage`
 * (claude-code-src/full/services/compact/prompt.ts:337) before writing
 * the `isCompactSummary: true` user entry. This preamble is the exact
 * first-line prefix that function emits. When translating Claude →
 * Codex we strip it so Codex sees just the informational summary
 * body; the Codex `SUMMARY_PREFIX` is prepended on top before
 * emission so Codex's native detection still fires.
 */
const CLAUDE_COMPACT_WRAPPER_PREFIX =
  'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n'

/**
 * Trailing lines that `getCompactUserSummaryMessage` appends after the
 * summary body (transcript pointer, suppress-questions continuation
 * instructions, proactive-mode note). We strip whichever of these
 * appear so the extracted summary body doesn't carry Claude-specific
 * runtime instructions into the Codex rollout.
 */
const CLAUDE_COMPACT_WRAPPER_SUFFIX_MARKERS = [
  '\n\nIf you need specific details from before compaction',
  '\n\nRecent messages are preserved verbatim.',
  '\nContinue the conversation from where it left off',
]

function isClaudeCompactSummaryEntry(entry: ClaudeEntry): boolean {
  if (entry.type !== 'user') return false
  if (entry.isCompactSummary !== true) return false
  return true
}

function extractClaudeSummaryText(entry: ClaudeEntry): string {
  const content = entry.message?.content
  let raw = ''
  if (typeof content === 'string') {
    raw = content
  } else if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (
        block &&
        typeof block === 'object' &&
        (block as { type?: string }).type === 'text' &&
        typeof (block as { text?: string }).text === 'string'
      ) {
        parts.push((block as { text: string }).text)
      }
    }
    raw = parts.join('\n\n')
  }
  let body = raw.startsWith(CLAUDE_COMPACT_WRAPPER_PREFIX)
    ? raw.slice(CLAUDE_COMPACT_WRAPPER_PREFIX.length)
    : raw
  for (const marker of CLAUDE_COMPACT_WRAPPER_SUFFIX_MARKERS) {
    const idx = body.indexOf(marker)
    if (idx >= 0) body = body.slice(0, idx)
  }
  return body.trim()
}

function entryStartsNewTurn(entry: ClaudeEntry): boolean {
  // Only a subset of Claude entries should open a fresh Codex turn.
  //
  // Why this explicit gate exists:
  // Claude stores several non-chat things inline in the transcript
  // chain (attachments, hidden meta notes, tool results). If we let
  // every translated entry start a turn, Codex ends up with a long
  // stream of fake micro-turns that never existed semantically. That
  // hurts resume rendering and makes the session look like the user
  // kept interrupting themselves.
  //
  // So we only open turns for entries that are genuinely "new user
  // asks for work" boundaries in Codex terms.
  if (entry.type === 'user') return userEntryHasText(entry)
  if (entry.type === 'attachment') return attachmentStartsNewTurn(entry)
  return false
}

// ---------------------------------------------------------------------------
// user entries
// ---------------------------------------------------------------------------

function mapUserEntry(entry: ClaudeEntry): CodexRolloutLine[] {
  if (!entry.message) return []
  const blocks = normalizeContent(entry.message.content)
  const lines: CodexRolloutLine[] = []

  const textItems: CodexContentItem[] = []
  const textParts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      const text = (block as { text: string }).text
      textItems.push({ type: 'input_text', text })
      textParts.push(text)
    } else if (block.type === 'tool_result') {
      lines.push(emitToolResult(entry, block as ClaudeToolResultBlock))
    } else {
      const fallback = summarizeNonTextUserBlock(block)
      if (!fallback) continue
      textItems.push({ type: 'input_text', text: fallback })
      textParts.push(fallback)
    }
  }

  if (textItems.length > 0) {
    // Emit BOTH an event_msg user_message AND a response_item message.
    // This matches Codex's native wire format for a user turn: the
    // event is what the user typed; the response_item is what gets
    // sent to the model. Discovery/resume scans the first ~10 lines
    // for an EventMsg::UserMessage to flag `saw_user_event`; without
    // it the file is filtered out of `codex resume` (even though
    // the file is on disk, well-formed, and has the right filename).
    // See codex-rs/rollout/src/list.rs:1066.
    lines.unshift({
      timestamp: entry.timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: textItems,
      },
    })
    lines.unshift({
      timestamp: entry.timestamp,
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: textParts.join('\n\n'),
      },
    })
  }

  return lines
}

function emitToolResult(
  entry: ClaudeEntry,
  block: ClaudeToolResultBlock,
): CodexRolloutLine {
  const kind = (block.codex?.kind as string | undefined) ?? 'function_call_output'
  const content = stringifyToolResultContent(block.content)

  if (kind === 'custom_tool_call_output') {
    // Codex serializes custom_tool_call_output exactly like its other tool
    // outputs: `output` is the wire payload body itself, not a JSON-wrapped
    // envelope. Keeping the payload bare avoids native Codex renderers
    // showing a stringified `{ output, metadata }` blob in lossy mode.
    //
    // Fidelity metadata still lives on the Claude-side block via
    // `block.codex`, so round-trip mode can preserve it without polluting
    // the native Codex transcript shape.
    return {
      timestamp: entry.timestamp,
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        call_id: block.tool_use_id,
        ...(block.codex?.name ? { name: block.codex.name as string } : {}),
        output: content,
      },
    }
  }

  // function_call_output default
  return {
    timestamp: entry.timestamp,
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      call_id: block.tool_use_id,
      output: content,
    },
  }
}

function summarizeNonTextUserBlock(block: ClaudeContentBlock): string | null {
  // Claude user turns can contain image/document blocks from pasted files.
  // Dropping those silently in lossy mode erases user intent entirely.
  // We preserve a compact textual marker instead so Codex still records
  // that the user supplied non-text context, even when we cannot recreate
  // the exact multimodal payload natively.
  if (block.type === 'image') {
    const sourceValue = (block as { source?: unknown }).source
    const sourceRecord = isRecord(sourceValue) ? sourceValue : null
    const source =
      sourceRecord && typeof sourceRecord.media_type === 'string'
        ? sourceRecord.media_type
        : 'image'
    return `[User attached image: ${source}]`
  }
  if (block.type === 'document') {
    const title =
      typeof (block as { title?: unknown }).title === 'string'
        ? (block as { title?: string }).title
        : 'document'
    return `[User attached document: ${title}]`
  }
  return null
}

/**
 * Rewrite or drop a codex-origin source line before re-emitting it
 * through the sidecar short-circuit. Returns the line to emit, or
 * `null` to skip it entirely.
 *
 * WHY this exists:
 * -----------------
 * The sidecar short-circuit re-emits codex lines byte-identical for
 * round-trip fidelity. That's correct for CONTENT-bearing lines
 * (response_item:message, function_call, function_call_output,
 * reasoning, agent_message, etc.) but wrong for lines whose semantics
 * are ONE-SHOT HISTORY MUTATIONS consumed by
 * `reconstruct_history_from_rollout` at resume time. Those mutations
 * were already applied in the ORIGINAL session's view of history;
 * re-applying them on every subsequent resume is a bug with real user
 * impact — provable:
 *
 *   - `event_msg:thread_rolled_back` → codex-rs/core/src/codex/
 *     rollout_reconstruction.rs:130-132 records it as
 *     `pending_rollback_turns`, then `finalize_active_segment`
 *     (line 53-58) SKIPS the next N user-turn segments during the
 *     reverse walk. A source session's past `/rollback 2` resumes as
 *     "drop the last 2 user turns again" every time the user switches
 *     provider — observed in Agent Code as the "jumped back N messages"
 *     symptom.
 *
 *   - `compacted` with `replacement_history` → rollout_reconstruction.
 *     rs:251-254 calls `history.replace(replacement_history.clone())`
 *     on forward replay. A source session's old /compact with a
 *     19-item replacement_history, round-tripped through Agent Code's
 *     Claude→Codex switch, truncates the resumed conversation back to
 *     those 19 items every time. (The message text is preserved so the
 *     compact boundary still marks correctly; only the `replace` effect
 *     is destructive.)
 *
 *   - `event_msg:turn_aborted` → rollout_reconstruction.rs:143-156
 *     uses it during the reverse scan to seed the `active_segment`
 *     turn_id. A stale abort signal from a past session can cause the
 *     reverse walk to attribute subsequent events to the wrong
 *     segment, leaving resume metadata inconsistent.
 *
 *   - `event_msg:context_compacted` → legacy compaction signal; same
 *     class of stale-footprint problem.
 *
 * WHY drop these instead of rewriting their sidecars:
 * ----------------------------------------------------
 * The sidecar's purpose is to preserve Codex→Claude→Codex round-trip
 * IN AN IDLE FILE — e.g. for backup/export tooling that never resumes
 * the output. Agent Code's use case is different: the output IS about
 * to be resumed by Codex. Resume safety outweighs round-trip fidelity
 * for these specific event types, and the corresponding Claude-side
 * sentinel (`system:codex_event_msg` / `system:compact_boundary`)
 * still exists in any Claude file that carried these through — so a
 * pure-export path that needs byte-identical fidelity can still
 * recover them by reading the Claude file directly rather than
 * round-tripping through a Codex translation.
 *
 * WHY keep `compacted.message` but strip `replacement_history`:
 * -------------------------------------------------------------
 * Codex's reconstruction falls back to `build_compacted_history`
 * (compact.rs) when a `compacted` line has no `replacement_history`
 * (rollout_reconstruction.rs:256-272). That fallback still treats the
 * line as a compaction boundary and still rebuilds a summary-based
 * history, but it DERIVES the replacement from the rollout's own
 * user messages rather than REPLAYING a frozen snapshot. Crucially,
 * the derived replacement reflects the CURRENT rollout's content,
 * including any Claude-side turns added after the boundary — so the
 * resumed conversation sees everything the user actually did.
 */
function sanitizeCodexSourceForReplay(
  line: CodexRolloutLine,
): CodexRolloutLine | null {
  if (line.type === 'event_msg') {
    const payload = line.payload as { type?: string }
    if (
      payload.type === 'thread_rolled_back' ||
      payload.type === 'turn_aborted' ||
      payload.type === 'context_compacted'
    ) {
      return null
    }
  }
  if (line.type === 'compacted') {
    const payload = line.payload as {
      message?: string
      replacement_history?: unknown
    }
    if (Array.isArray(payload.replacement_history)) {
      // Preserve the boundary + summary, drop the snapshot. Codex's
      // reconstruction re-derives replacement content from the live
      // rollout instead of replaying the frozen one.
      const { replacement_history: _unused, ...rest } = payload
      return {
        ...line,
        payload: { ...rest, message: typeof payload.message === 'string' ? payload.message : '' },
      } as CodexRolloutLine
    }
  }
  return line
}

function codexLineCwd(line: CodexRolloutLine): string | undefined {
  if (
    line.type === 'session_meta' &&
    typeof line.payload.cwd === 'string' &&
    line.payload.cwd.length > 0
  ) {
    return line.payload.cwd
  }
  if (
    line.type === 'turn_context' &&
    typeof line.payload.cwd === 'string' &&
    line.payload.cwd.length > 0
  ) {
    return line.payload.cwd
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function stringifyToolResultContent(
  content: ClaudeToolResultBlock['content'],
): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  const parts = content.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    if (item.type === 'text' && typeof item.text === 'string') {
      return item.text
    }
    if (item.type === 'image') return '[image]'
    if (item.type === 'document') return '[document]'
    if (item.type === 'search_result') {
      const title =
        typeof item.title === 'string'
          ? item.title
          : typeof item.url === 'string'
            ? item.url
            : 'search result'
      return `[search_result: ${title}]`
    }
    return []
  })

  return parts.join('\n').trim()
}

// ---------------------------------------------------------------------------
// attachment entries
// ---------------------------------------------------------------------------

function mapAttachmentEntry(entry: ClaudeEntry): CodexRolloutLine[] {
  const attachment = entry.attachment
  if (!attachment || typeof attachment.type !== 'string') return passthroughLine(entry)

  if (attachment.type === 'queued_command') {
    return mapQueuedCommandAttachment(entry, attachment)
  }
  if (attachment.type === 'edited_text_file') {
    return mapEditedTextFileAttachment(entry, attachment)
  }
  if (attachment.type === 'diagnostics') {
    return mapDiagnosticsAttachment(entry, attachment)
  }
  if (
    attachment.type === 'plan_mode' ||
    attachment.type === 'plan_mode_reentry' ||
    attachment.type === 'plan_mode_exit' ||
    attachment.type === 'auto_mode' ||
    attachment.type === 'auto_mode_exit'
  ) {
    return mapModeAttachment(entry, attachment)
  }
  if (attachment.type === 'date_change') {
    return mapDateChangeAttachment(entry, attachment)
  }
  if (attachment.type === 'mcp_resource') {
    return mapMcpResourceAttachment(entry, attachment)
  }
  if (
    attachment.type === 'critical_system_reminder' ||
    attachment.type === 'token_usage' ||
    attachment.type === 'budget_usd' ||
    attachment.type === 'output_token_usage' ||
    attachment.type === 'verify_plan_reminder' ||
    attachment.type === 'max_turns_reached' ||
    attachment.type === 'compaction_reminder' ||
    attachment.type === 'context_efficiency'
  ) {
    return mapReminderAttachment(entry, attachment)
  }
  if (attachment.type === 'task_status') {
    return mapTaskStatusAttachment(entry, attachment)
  }
  if (
    attachment.type === 'hook_blocking_error' ||
    attachment.type === 'hook_success' ||
    attachment.type === 'hook_additional_context' ||
    attachment.type === 'hook_stopped_continuation'
  ) {
    return mapHookAttachment(entry, attachment)
  }
  if (
    attachment.type === 'agent_listing_delta' ||
    attachment.type === 'mcp_instructions_delta'
  ) {
    return mapCapabilityDeltaAttachment(entry, attachment)
  }
  if (
    attachment.type === 'plan_file_reference' ||
    attachment.type === 'invoked_skills'
  ) {
    return mapContextReferenceAttachment(entry, attachment)
  }
  if (
    attachment.type === 'todo_reminder' ||
    attachment.type === 'task_reminder' ||
    attachment.type === 'output_style' ||
    attachment.type === 'ultrathink_effort' ||
    attachment.type === 'deferred_tools_delta' ||
    attachment.type === 'skill_listing' ||
    attachment.type === 'agent_mention'
  ) {
    return mapInstructionAttachment(entry, attachment)
  }

  return passthroughLine(entry)
}

function mapCustomTitleEntry(entry: ClaudeEntry): CodexRolloutLine[] {
  const title = typeof entry.customTitle === 'string' ? entry.customTitle.trim() : ''
  if (!title) return passthroughLine(entry)

  // This is the exact metadata dual of the reverse mapping in toClaude:
  // Codex persists user-visible thread renames as `thread_name_updated`
  // events, while Claude persists them as `custom-title` entries.
  // Translating directly preserves rename/resume metadata on both sides
  // instead of burying the title in a sidecar that lossy mode drops.
  return [
    {
      timestamp: entry.timestamp,
      type: 'event_msg',
      payload: {
        type: 'thread_name_updated',
        thread_name: title,
      },
    },
  ]
}

function mapQueuedCommandAttachment(
  entry: ClaudeEntry,
  attachment: Record<string, unknown>,
): CodexRolloutLine[] {
  const prompt = typeof attachment.prompt === 'string' ? attachment.prompt.trim() : ''
  if (!prompt) return passthroughLine(entry)

  // Claude's queued_command attachment is not just decorative metadata.
  // On resume, Claude rehydrates it back into a real user prompt-like
  // message with origin/isMeta context. Codex has no equivalent
  // attachment bucket, so the least-wrong native representation is an
  // actual user turn: event_msg:user_message plus the paired
  // response_item message.
  //
  // This is intentionally stronger than passthrough because:
  // 1. queued_command affects conversational continuity, not just UI
  // 2. Codex listing/resume expects real user_message events
  // 3. dropping it to a private sidecar makes lossy mode look like the
  //    user never asked for that work
  return [
    {
      timestamp: entry.timestamp,
      type: 'event_msg',
      payload: {
        type: 'user_message',
        message: prompt,
      },
    },
    {
      timestamp: entry.timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: prompt }],
      },
    },
  ]
}

function mapEditedTextFileAttachment(
  entry: ClaudeEntry,
  attachment: Record<string, unknown>,
): CodexRolloutLine[] {
  const filename = typeof attachment.filename === 'string' ? attachment.filename : undefined
  const snippet = typeof attachment.snippet === 'string' ? attachment.snippet.trim() : ''
  const text = filename
    ? `Edited file: ${filename}`
    : snippet || 'Edited a file.'

  // Claude models file-change evidence as attachments because the raw
  // edit artifact carries more structure than a normal chat message.
  // Codex does not have a parallel attachment primitive in the rollout
  // stream, so we intentionally degrade to a visible assistant note
  // instead of pretending this is a user turn.
  //
  // Why assistant commentary and not user_message:
  // - the edit was produced by the agent/tooling, not typed by the user
  // - turning it into a user event would pollute Codex title/listing
  //   heuristics, which key off early user_message items
  // - an assistant-side status line keeps the edit visible in lossy
  //   mode without lying about who originated it
  return [
    {
      timestamp: entry.timestamp,
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        message: text,
        phase: 'commentary',
      },
    },
    {
      timestamp: entry.timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'commentary',
        content: [{ type: 'output_text', text }],
      },
    },
  ]
}

function mapDiagnosticsAttachment(
  entry: ClaudeEntry,
  attachment: Record<string, unknown>,
): CodexRolloutLine[] {
  const text = summarizeDiagnosticsAttachment(attachment)

  // Claude diagnostics attachments are genuine transcript state: they
  // carry IDE/LSP feedback the model saw mid-session. Codex has no
  // dedicated rollout item for "diagnostics attachment arrived", so we
  // preserve the information as assistant commentary rather than
  // silently discarding it in lossy mode.
  //
  // This intentionally stays assistant-side for the same reason as the
  // edited-file mapping above: diagnostics are environmental feedback to
  // the agent, not a new user prompt and not something that should
  // influence Codex title/listing heuristics.
  return [
    {
      timestamp: entry.timestamp,
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        message: text,
        phase: 'commentary',
      },
    },
    {
      timestamp: entry.timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'commentary',
        content: [{ type: 'output_text', text }],
      },
    },
  ]
}

function mapModeAttachment(
  entry: ClaudeEntry,
  attachment: Record<string, unknown>,
): CodexRolloutLine[] {
  const text = summarizeModeAttachment(attachment)

  // Claude uses attachments for mode reminders/exits because these are
  // side-channel constraints fed back into the model mid-session.
  // Codex has no equivalent inline constraint-attachment primitive, so
  // the best native fallback is explicit assistant commentary. That
  // keeps the mode transition visible without pretending it was a user
  // request or a tool execution.
  return [
    {
      timestamp: entry.timestamp,
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        message: text,
        phase: 'commentary',
      },
    },
    {
      timestamp: entry.timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'commentary',
        content: [{ type: 'output_text', text }],
      },
    },
  ]
}

function mapDateChangeAttachment(
  entry: ClaudeEntry,
  attachment: Record<string, unknown>,
): CodexRolloutLine[] {
  const date =
    typeof attachment.newDate === 'string' && attachment.newDate.length > 0
      ? attachment.newDate
      : 'a new date'

  // Date-change attachments are Claude's way to tell the model that the
  // ambient "today" context shifted mid-session. Codex has no dedicated
  // attachment for that signal, but dropping it would make relative-time
  // reasoning less reproducible in lossy exports.
  return assistantCommentaryLines(entry.timestamp, `Current date changed to ${date}.`)
}

function mapMcpResourceAttachment(
  entry: ClaudeEntry,
  attachment: Record<string, unknown>,
): CodexRolloutLine[] {
  const server = typeof attachment.server === 'string' ? attachment.server : 'MCP'
  const name = typeof attachment.name === 'string' ? attachment.name : undefined
  const uri = typeof attachment.uri === 'string' ? attachment.uri : undefined
  const label = name ?? uri ?? 'resource'

  // Claude persists MCP resources as attachments because they are
  // context injections, not chat utterances. Codex likewise lacks a
  // first-class "resource injected" rollout item here, so we degrade to
  // commentary that at least preserves the fact that the resource was
  // loaded and from where.
  return assistantCommentaryLines(
    entry.timestamp,
    `Loaded MCP resource from ${server}: ${label}.`,
  )
}

function mapReminderAttachment(
  entry: ClaudeEntry,
  attachment: Record<string, unknown>,
): CodexRolloutLine[] {
  return assistantCommentaryLines(
    entry.timestamp,
    summarizeReminderAttachment(attachment),
  )
}

function mapTaskStatusAttachment(
  entry: ClaudeEntry,
  attachment: Record<string, unknown>,
): CodexRolloutLine[] {
  // Claude emits task_status after compaction to preserve "there is still
  // work happening in the background" context even when the original spawn
  // turn has fallen out of the immediate transcript window. Codex has no
  // first-class persisted attachment for that, so we preserve the signal as
  // assistant commentary rather than silently dropping it in lossy mode.
  //
  // This must stay assistant-side:
  // - it is not a user utterance
  // - it should not influence Codex's first-user/title heuristics
  // - it is advisory state for the agent about ongoing background work
  return assistantCommentaryLines(
    entry.timestamp,
    summarizeTaskStatusAttachment(attachment),
  )
}

function mapHookAttachment(
  entry: ClaudeEntry,
  attachment: Record<string, unknown>,
): CodexRolloutLine[] {
  const text = summarizeHookAttachment(attachment)
  if (!text) return passthroughLine(entry)

  // Hook attachments are mostly hidden/system-reminder context in Claude,
  // not visible chat. We still preserve the ones that messages.ts turns into
  // explicit reminder text, because those carry actionable continuation
  // constraints on resume. The other hook variants stay passthrough-only
  // until we have a more faithful Codex target.
  return assistantCommentaryLines(entry.timestamp, text)
}

function mapCapabilityDeltaAttachment(
  entry: ClaudeEntry,
  attachment: Record<string, unknown>,
): CodexRolloutLine[] {
  const text = summarizeCapabilityDeltaAttachment(attachment)
  if (!text) return passthroughLine(entry)

  // These attachment families are capability/instruction deltas that
  // Claude injects as hidden reminder text. They are not user prompts,
  // but dropping them in lossy mode would erase the fact that the model
  // saw a capability change mid-session. Assistant commentary is the
  // least misleading persisted Codex fallback.
  return assistantCommentaryLines(entry.timestamp, text)
}

function mapContextReferenceAttachment(
  entry: ClaudeEntry,
  attachment: Record<string, unknown>,
): CodexRolloutLine[] {
  const text = summarizeContextReferenceAttachment(attachment)
  if (!text) return passthroughLine(entry)

  // These attachments carry durable context Claude injected back into the
  // model (existing plan contents, invoked skill guidance). They are not
  // direct user turns, but they materially affect how the resumed agent
  // should behave, so keeping them as Codex assistant commentary is a
  // better lossy fallback than dropping them outright.
  return assistantCommentaryLines(entry.timestamp, text)
}

function mapInstructionAttachment(
  entry: ClaudeEntry,
  attachment: Record<string, unknown>,
): CodexRolloutLine[] {
  const text = summarizeInstructionAttachment(attachment)
  if (!text) return passthroughLine(entry)

  // Claude already rehydrates these attachments as plain system-reminder
  // user messages rather than as tools, progress cells, or hidden binary
  // blobs. That makes them a good fit for Codex assistant commentary:
  // the resumed model still sees the guidance, but we avoid lying about
  // them being real user turns, tool invocations, or capability records.
  //
  // We are intentionally drawing the line before large memory/file payloads
  // here. Those attachments can explode transcript size and deserve a
  // separate policy. This helper is only for the "Claude itself turns this
  // into reminder text" family.
  return assistantCommentaryLines(entry.timestamp, text)
}

// ---------------------------------------------------------------------------
// assistant entries
// ---------------------------------------------------------------------------

function mapAssistantEntry(entry: ClaudeEntry): CodexRolloutLine[] {
  if (!entry.message) return []
  const blocks = normalizeContent(entry.message.content)
  const lines: CodexRolloutLine[] = []

  const textItems: CodexContentItem[] = []
  const textParts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      const text = (block as { text: string }).text
      textItems.push({ type: 'output_text', text })
      textParts.push(text)
    } else if (block.type === 'tool_use') {
      lines.push(emitToolUse(entry, block as ClaudeToolUseBlock))
    } else if (block.type === 'thinking') {
      lines.push(emitReasoning(entry, block as ClaudeThinkingBlock))
    }
  }

  if (textItems.length > 0) {
    // Emit BOTH an event_msg agent_message AND a response_item message.
    // Same dual-emission pattern Codex uses natively for user turns
    // (see mapUserEntry). The TUI renders from the event_msg side;
    // the response_item is what the model saw on the protocol level.
    // Without the event_msg, the message is preserved on disk but
    // never shows up in `codex resume` rendering (the UI walks events,
    // not raw response_items).
    //
    // phase='final_answer' matches Codex's own default for a completed
    // assistant turn. The `commentary` phase is used for interim
    // "about to do X" narration and would render slightly differently;
    // Claude's assistant text is always a completed answer-ish block,
    // so final_answer is the semantically closer fit.
    lines.unshift({
      timestamp: entry.timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: textItems,
        phase: 'final_answer',
      },
    })
    lines.unshift({
      timestamp: entry.timestamp,
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        message: textParts.join('\n\n'),
        phase: 'final_answer',
      },
    })
  }

  return lines
}

function emitToolUse(
  entry: ClaudeEntry,
  block: ClaudeToolUseBlock,
): CodexRolloutLine {
  const localShell = toLocalShellPayload(block)
  if (localShell) {
    return {
      timestamp: entry.timestamp,
      type: 'response_item',
      payload: localShell,
    }
  }

  const kind = (block.codex?.kind as string | undefined) ?? 'function_call'
  const argsJson = JSON.stringify(block.input)

  if (kind === 'custom_tool_call') {
    return {
      timestamp: entry.timestamp,
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        call_id: block.id,
        name: block.name,
        input: argsJson,
        ...(block.codex?.status ? { status: block.codex.status as string } : {}),
      },
    }
  }

  return {
    timestamp: entry.timestamp,
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: block.name,
      ...(block.codex?.namespace
        ? { namespace: block.codex.namespace as string }
        : {}),
      arguments: argsJson,
      call_id: block.id,
    },
  }
}

function toLocalShellPayload(
  block: ClaudeToolUseBlock,
): {
  type: 'local_shell_call'
  call_id: string
  status: string
  action: {
    type: 'exec'
    command: string[]
    working_directory?: string
    env: Record<string, string>
  }
} | null {
  // Only upgrade to Codex's `local_shell_call` when the block was
  // explicitly tagged as a Codex local_shell_call via round-trip
  // metadata. Previously we also upgraded ANY `block.name === 'Bash'`,
  // which was wrong in two compounding ways:
  //
  //   1. Claude's Bash is a regular function-style tool, not OpenAI's
  //      hosted `local_shell` tool. Emitting it as `local_shell_call`
  //      lies about the item type.
  //
  //   2. `local_shell_call` is a HOSTED OpenAI tool with strict schema
  //      validation on resume. When Codex replays a translated
  //      transcript to /v1/responses, the OpenAI API validates
  //      `action.env` and rejects the whole request with
  //      `Invalid type for 'input[N].action.env': expected an object
  //      with string keys and string values, but got null instead.`
  //      because Codex's on-disk Option<HashMap> round-trips to `null`.
  //
  // Native Codex itself doesn't actually use `local_shell_call` for
  // its shell — it uses `function_call name='exec_command'` (see any
  // fresh ~/.codex/sessions/.../rollout-*.jsonl). So plain Claude Bash
  // should fall through to the generic function_call emission path,
  // which produces a transcript-safe item OpenAI won't strict-validate.
  const kind = block.codex?.kind as string | undefined
  if (kind !== 'local_shell_call') return null
  if (typeof block.input !== 'object' || block.input === null) return null

  const command = extractBashCommand(block.input)
  if (!command) return null

  const input = block.input as Record<string, unknown>
  const workingDirectory =
    typeof input.workdir === 'string'
      ? input.workdir
      : typeof input.working_directory === 'string'
        ? input.working_directory
        : undefined

  return {
    type: 'local_shell_call',
    call_id: block.id,
    status: typeof block.codex?.status === 'string' ? block.codex.status : 'completed',
    action: {
      type: 'exec',
      command: [command],
      ...(workingDirectory ? { working_directory: workingDirectory } : {}),
      // env MUST be a concrete object, never null/undefined. OpenAI's
      // hosted local_shell_call schema rejects `env: null` with
      // invalid_type. Codex's Rust struct has `env: Option<HashMap>`
      // without skip_serializing_if, so a missing env on disk
      // deserializes back to None and re-serializes as explicit
      // `null` when Codex posts history to /v1/responses. The empty
      // object is schema-valid and semantically equivalent to "no
      // extra env" as far as replay goes (the tool already ran; this
      // is historical context, not a fresh exec request).
      env: {},
    },
  }
}

function extractBashCommand(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null
  const record = input as Record<string, unknown>
  if (typeof record.command === 'string' && record.command.trim().length > 0) {
    return record.command
  }
  if (typeof record.cmd === 'string' && record.cmd.trim().length > 0) {
    return record.cmd
  }
  return null
}

function emitReasoning(
  entry: ClaudeEntry,
  block: ClaudeThinkingBlock,
): CodexRolloutLine {
  const id = block.codex?.id as string | undefined
  const encrypted = block.codex?.encrypted_content as string | undefined
  return {
    timestamp: entry.timestamp,
    type: 'response_item',
    payload: {
      type: 'reasoning',
      ...(id ? { id } : {}),
      summary: block.thinking
        ? [{ type: 'summary_text', text: block.thinking }]
        : [],
      ...(encrypted ? { encrypted_content: encrypted } : {}),
    },
  }
}

// ---------------------------------------------------------------------------
// system entries
// ---------------------------------------------------------------------------

function extractCodexCompactedPayload(
  entry: ClaudeEntry,
): Record<string, unknown> | null {
  const metadata = entry.compactMetadata
  if (!isRecord(metadata)) return null
  if (typeof metadata.message !== 'string') return null
  if (
    metadata.replacement_history !== undefined &&
    !Array.isArray(metadata.replacement_history)
  ) {
    return null
  }
  return { ...metadata }
}

function mapSystemEntry(entry: ClaudeEntry): CodexRolloutLine[] {
  if (entry.subtype === 'compact_boundary') {
    const payload = extractCodexCompactedPayload(entry)
    if (!payload) {
      return []
    }
    return [
      {
        timestamp: entry.timestamp,
        type: 'compacted',
        payload,
      },
    ]
  }
  // Other system subtypes (codex_unknown, file-history-snapshot, etc.)
  // have no native Codex form. Drop. Round-trip for these only works
  // via the sidecar short-circuit path (which isn't hit when the
  // input entry had no _atp).
  return []
}

function attachmentStartsNewTurn(entry: ClaudeEntry): boolean {
  // queued_command is the one attachment family we currently treat as
  // a true user-turn boundary. Other attachment types are metadata or
  // post-tool side effects and should stay inside the surrounding turn.
  return Boolean(
    entry.attachment &&
      entry.attachment.type === 'queued_command' &&
      typeof entry.attachment.prompt === 'string' &&
      entry.attachment.prompt.trim().length > 0,
  )
}

function passthroughLine(entry: ClaudeEntry): CodexRolloutLine[] {
  return [
    {
      timestamp: entry.timestamp ?? new Date().toISOString(),
      type: 'atp_passthrough',
      payload: { source_type: entry.type },
    },
  ]
}

function assistantCommentaryLines(
  timestamp: string,
  text: string,
): CodexRolloutLine[] {
  return [
    {
      timestamp,
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        message: text,
        phase: 'commentary',
      },
    },
    {
      timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'commentary',
        content: [{ type: 'output_text', text }],
      },
    },
  ]
}

function summarizeDiagnosticsAttachment(
  attachment: Record<string, unknown>,
): string {
  const files = Array.isArray(attachment.files) ? attachment.files : []
  const fileCount = files.length
  const diagnosticCount = files.reduce((count, file) => {
    if (typeof file !== 'object' || file === null) return count
    const diagnostics = (file as { diagnostics?: unknown }).diagnostics
    return count + (Array.isArray(diagnostics) ? diagnostics.length : 0)
  }, 0)
  const firstUri = files.find(
    (file): file is { uri: string } =>
      typeof file === 'object' &&
      file !== null &&
      typeof (file as { uri?: unknown }).uri === 'string',
  )?.uri

  if (fileCount === 0) return 'Received diagnostics.'
  if (firstUri && fileCount === 1) {
    return `Received ${diagnosticCount} diagnostic${diagnosticCount === 1 ? '' : 's'} for ${firstUri}.`
  }
  return `Received ${diagnosticCount} diagnostics across ${fileCount} files.`
}

function summarizeModeAttachment(attachment: Record<string, unknown>): string {
  switch (attachment.type) {
    case 'plan_mode': {
      const reminderType =
        attachment.reminderType === 'sparse' ? 'sparse' : 'full'
      return `Plan mode reminder (${reminderType}).`
    }
    case 'plan_mode_reentry':
      return 'Re-entered plan mode.'
    case 'plan_mode_exit':
      return 'Exited plan mode.'
    case 'auto_mode': {
      const reminderType =
        attachment.reminderType === 'sparse' ? 'sparse' : 'full'
      return `Auto mode reminder (${reminderType}).`
    }
    case 'auto_mode_exit':
      return 'Exited auto mode.'
    default:
      return 'Mode update.'
  }
}

function summarizeReminderAttachment(
  attachment: Record<string, unknown>,
): string {
  switch (attachment.type) {
    case 'critical_system_reminder':
      return typeof attachment.content === 'string' && attachment.content.trim().length > 0
        ? attachment.content
        : 'Critical system reminder.'
    case 'token_usage':
      return `Token usage: ${attachment.used}/${attachment.total}; ${attachment.remaining} remaining.`
    case 'budget_usd':
      return `USD budget: $${attachment.used}/$${attachment.total}; $${attachment.remaining} remaining.`
    case 'output_token_usage':
      return attachment.budget == null
        ? `Output tokens - turn: ${attachment.turn}; session: ${attachment.session}.`
        : `Output tokens - turn: ${attachment.turn}/${attachment.budget}; session: ${attachment.session}.`
    case 'verify_plan_reminder':
      return 'Plan verification reminder.'
    case 'max_turns_reached':
      return `Maximum turns reached: ${attachment.turnCount}/${attachment.maxTurns}.`
    case 'compaction_reminder':
      return 'Auto-compaction reminder.'
    case 'context_efficiency':
      return 'Context efficiency reminder.'
    default:
      return 'System reminder.'
  }
}

function summarizeTaskStatusAttachment(
  attachment: Record<string, unknown>,
): string {
  const taskId =
    typeof attachment.taskId === 'string' && attachment.taskId.length > 0
      ? attachment.taskId
      : 'unknown'
  const description =
    typeof attachment.description === 'string' && attachment.description.length > 0
      ? attachment.description
      : 'background task'
  const taskType =
    typeof attachment.taskType === 'string' && attachment.taskType.length > 0
      ? attachment.taskType
      : 'task'
  const status =
    attachment.status === 'killed'
      ? 'stopped'
      : typeof attachment.status === 'string'
        ? attachment.status
        : 'unknown'
  const delta =
    typeof attachment.deltaSummary === 'string' && attachment.deltaSummary.length > 0
      ? attachment.deltaSummary
      : undefined
  const outputFile =
    typeof attachment.outputFilePath === 'string' &&
    attachment.outputFilePath.length > 0
      ? attachment.outputFilePath
      : undefined

  if (attachment.status === 'killed') {
    return `Task "${description}" (${taskId}) was stopped by the user.`
  }

  if (attachment.status === 'running') {
    const parts = [`Background task "${description}" (${taskId}) is still running.`]
    if (delta) parts.push(`Progress: ${delta}`)
    if (outputFile) {
      parts.push(`Partial output is available at ${outputFile}.`)
    }
    return parts.join(' ')
  }

  const parts = [
    `Task ${taskId} (type: ${taskType}) (status: ${status}) (description: ${description}).`,
  ]
  if (delta) parts.push(`Delta: ${delta}`)
  if (outputFile) {
    parts.push(`Read the output file to retrieve the result: ${outputFile}`)
  }
  return parts.join(' ')
}

function summarizeHookAttachment(
  attachment: Record<string, unknown>,
): string | null {
  switch (attachment.type) {
    case 'hook_blocking_error': {
      const hookName =
        typeof attachment.hookName === 'string' ? attachment.hookName : 'Hook'
      const blockingError =
        typeof attachment.blockingError === 'object' && attachment.blockingError !== null
          ? (attachment.blockingError as Record<string, unknown>)
          : {}
      const command =
        typeof blockingError.command === 'string' ? blockingError.command : 'unknown command'
      const error =
        typeof blockingError.blockingError === 'string'
          ? blockingError.blockingError
          : 'blocking error'
      return `${hookName} hook blocking error from command: "${command}": ${error}`
    }
    case 'hook_success': {
      // Claude only surfaces hook_success for SessionStart and
      // UserPromptSubmit. Other success attachments are intentionally
      // null-rendering, so we mirror that policy instead of suddenly
      // making every successful hook visible after translation.
      if (
        attachment.hookEvent !== 'SessionStart' &&
        attachment.hookEvent !== 'UserPromptSubmit'
      ) {
        return null
      }
      if (typeof attachment.content !== 'string' || attachment.content.length === 0) {
        return null
      }
      const hookName =
        typeof attachment.hookName === 'string' ? attachment.hookName : 'Hook'
      return `${hookName} hook success: ${attachment.content}`
    }
    case 'hook_additional_context': {
      if (!Array.isArray(attachment.content) || attachment.content.length === 0) {
        return null
      }
      const hookName =
        typeof attachment.hookName === 'string' ? attachment.hookName : 'Hook'
      const parts = attachment.content.filter(
        (part): part is string => typeof part === 'string' && part.length > 0,
      )
      if (parts.length === 0) return null
      return `${hookName} hook additional context: ${parts.join('\n')}`
    }
    case 'hook_stopped_continuation': {
      const hookName =
        typeof attachment.hookName === 'string' ? attachment.hookName : 'Hook'
      const message =
        typeof attachment.message === 'string' && attachment.message.length > 0
          ? attachment.message
          : 'continuation stopped'
      return `${hookName} hook stopped continuation: ${message}`
    }
    default:
      return null
  }
}

function summarizeCapabilityDeltaAttachment(
  attachment: Record<string, unknown>,
): string | null {
  switch (attachment.type) {
    case 'agent_listing_delta': {
      const parts: string[] = []
      const addedLines = Array.isArray(attachment.addedLines)
        ? attachment.addedLines.filter((x): x is string => typeof x === 'string' && x.length > 0)
        : []
      const removedTypes = Array.isArray(attachment.removedTypes)
        ? attachment.removedTypes.filter((x): x is string => typeof x === 'string' && x.length > 0)
        : []
      if (addedLines.length > 0) {
        const header = attachment.isInitial
          ? 'Available agent types:'
          : 'New agent types are now available:'
        parts.push(`${header}\n${addedLines.join('\n')}`)
      }
      if (removedTypes.length > 0) {
        parts.push(
          `The following agent types are no longer available:\n${removedTypes.map(t => `- ${t}`).join('\n')}`,
        )
      }
      return parts.length > 0 ? parts.join('\n\n') : null
    }
    case 'mcp_instructions_delta': {
      const parts: string[] = []
      const addedBlocks = Array.isArray(attachment.addedBlocks)
        ? attachment.addedBlocks.filter((x): x is string => typeof x === 'string' && x.length > 0)
        : []
      const removedNames = Array.isArray(attachment.removedNames)
        ? attachment.removedNames.filter((x): x is string => typeof x === 'string' && x.length > 0)
        : []
      if (addedBlocks.length > 0) {
        parts.push(
          `MCP server instructions changed:\n\n${addedBlocks.join('\n\n')}`,
        )
      }
      if (removedNames.length > 0) {
        parts.push(
          `The following MCP servers disconnected:\n${removedNames.join('\n')}`,
        )
      }
      return parts.length > 0 ? parts.join('\n\n') : null
    }
    default:
      return null
  }
}

function summarizeContextReferenceAttachment(
  attachment: Record<string, unknown>,
): string | null {
  switch (attachment.type) {
    case 'plan_file_reference': {
      const path =
        typeof attachment.planFilePath === 'string' ? attachment.planFilePath : 'plan file'
      const content =
        typeof attachment.planContent === 'string' ? attachment.planContent.trim() : ''
      if (!content) return `Plan file exists at ${path}.`
      return `Plan file reference: ${path}\n\n${content}`
    }
    case 'invoked_skills': {
      if (!Array.isArray(attachment.skills) || attachment.skills.length === 0) {
        return null
      }
      const rendered = attachment.skills
        .filter(
          (skill): skill is { name?: unknown; path?: unknown; content?: unknown } =>
            typeof skill === 'object' && skill !== null,
        )
        .map(skill => {
          const name = typeof skill.name === 'string' ? skill.name : 'skill'
          const path = typeof skill.path === 'string' ? skill.path : 'unknown path'
          const content = typeof skill.content === 'string' ? skill.content : ''
          return `Skill: ${name}\nPath: ${path}${content ? `\n\n${content}` : ''}`
        })
        .filter(Boolean)
      return rendered.length > 0
        ? `Invoked skills in this session:\n\n${rendered.join('\n\n---\n\n')}`
        : null
    }
    default:
      return null
  }
}

function summarizeInstructionAttachment(
  attachment: Record<string, unknown>,
): string | null {
  switch (attachment.type) {
    case 'todo_reminder': {
      const items = Array.isArray(attachment.content)
        ? attachment.content
            .filter(
              (todo): todo is { status?: unknown; content?: unknown } =>
                typeof todo === 'object' && todo !== null,
            )
            .map((todo, index) => {
              const status = typeof todo.status === 'string' ? todo.status : 'unknown'
              const content = typeof todo.content === 'string' ? todo.content : ''
              return `${index + 1}. [${status}] ${content}`.trimEnd()
            })
            .filter(Boolean)
        : []
      const suffix =
        items.length > 0 ? `\n\nExisting todo list:\n${items.join('\n')}` : ''
      return (
        "Todo tracking reminder: use TodoWrite when the current work would benefit from progress tracking, and clean up stale todo items when relevant." +
        suffix
      )
    }
    case 'task_reminder': {
      const items = Array.isArray(attachment.content)
        ? attachment.content
            .filter(
              (task): task is { id?: unknown; status?: unknown; subject?: unknown } =>
                typeof task === 'object' && task !== null,
            )
            .map(task => {
              const id = typeof task.id === 'number' || typeof task.id === 'string' ? task.id : '?'
              const status = typeof task.status === 'string' ? task.status : 'unknown'
              const subject = typeof task.subject === 'string' ? task.subject : ''
              return `#${id}. [${status}] ${subject}`.trimEnd()
            })
            .filter(Boolean)
        : []
      const suffix = items.length > 0 ? `\n\nExisting tasks:\n${items.join('\n')}` : ''
      return (
        'Task-tracking reminder: use the task tools when the current work would benefit from explicit task status tracking, and clean up stale tasks when relevant.' +
        suffix
      )
    }
    case 'output_style': {
      const style = typeof attachment.style === 'string' ? attachment.style : 'custom'
      return `Output style reminder: the active Claude output style is "${style}".`
    }
    case 'ultrathink_effort': {
      const level = typeof attachment.level === 'string' ? attachment.level : 'unknown'
      return `Reasoning effort reminder: the requested effort level is ${level}.`
    }
    case 'deferred_tools_delta': {
      const addedLines = Array.isArray(attachment.addedLines)
        ? attachment.addedLines.filter((x): x is string => typeof x === 'string' && x.length > 0)
        : []
      const removedNames = Array.isArray(attachment.removedNames)
        ? attachment.removedNames.filter((x): x is string => typeof x === 'string' && x.length > 0)
        : []
      const parts: string[] = []
      if (addedLines.length > 0) {
        parts.push(`Deferred tools now available:\n${addedLines.join('\n')}`)
      }
      if (removedNames.length > 0) {
        parts.push(`Deferred tools no longer available:\n${removedNames.join('\n')}`)
      }
      return parts.length > 0 ? parts.join('\n\n') : null
    }
    case 'skill_listing': {
      const content =
        typeof attachment.content === 'string' ? attachment.content.trim() : ''
      return content ? `Available skills:\n\n${content}` : null
    }
    case 'agent_mention': {
      const agentType =
        typeof attachment.agentType === 'string' && attachment.agentType.length > 0
          ? attachment.agentType
          : 'agent'
      return `Agent invocation reminder: the user explicitly asked to invoke the "${agentType}" agent type.`
    }
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// content-block utilities
// ---------------------------------------------------------------------------

/** Claude content can be either a string or an array of blocks.
 *  Normalize to a block array so the mappers don't have to branch. */
function normalizeContent(
  content: string | ClaudeContentBlock[] | undefined,
): ClaudeContentBlock[] {
  if (content == null) return []
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : []
  }
  return content
}

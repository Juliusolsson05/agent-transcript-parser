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
  const seenSourceUuids = new Set<string>()

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

  for (const entry of entries) {
    const sidecar = readSidecar(entry)
    if (sidecar?.origin === 'codex') {
      const source = sidecar.source
      const sourceKey = JSON.stringify({
        timestamp: source.timestamp,
        type: source.type,
      })
      if (seenSourceUuids.has(sourceKey)) continue
      seenSourceUuids.add(sourceKey)
      out.push(source)
      if (source.type === 'session_meta') sessionMetaEmitted = true
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
      const startedAtSec = Math.floor(
        Date.parse(entry.timestamp) / 1000,
      ) || 0
      out.push(markSynth({
        timestamp: entry.timestamp,
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: openTurn.id,
          started_at: startedAtSec,
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
    }
    // Unknown user-side blocks are dropped.
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
  const content = typeof block.content === 'string' ? block.content : ''
  const metadata = block.codex?.metadata as Record<string, unknown> | undefined

  if (kind === 'custom_tool_call_output') {
    // Reconstruct the JSON-wrapped output form custom tools use.
    const wrapped = JSON.stringify({
      output: content,
      ...(metadata ? { metadata } : {}),
    })
    return {
      timestamp: entry.timestamp,
      type: 'response_item',
      payload: {
        type: 'custom_tool_call_output',
        call_id: block.tool_use_id,
        ...(block.codex?.name ? { name: block.codex.name as string } : {}),
        output: wrapped,
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
  }
} | null {
  const kind = block.codex?.kind as string | undefined
  if (kind !== 'local_shell_call' && block.name !== 'Bash') return null
  if (typeof block.input !== 'object' || block.input === null) return null

  const command = extractBashCommand(block.input)
  if (!command) return null

  // We only upgrade Bash -> local_shell_call when we can recover a
  // concrete command string. Otherwise we leave the block as a generic
  // function_call, because emitting a half-empty local_shell_call is
  // worse than not upgrading at all: Codex normalizers assume these
  // items are executable shell actions and may synthesize missing
  // outputs around them.
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
        ? [{ type: 'text', text: block.thinking }]
        : [],
      ...(encrypted ? { encrypted_content: encrypted } : {}),
    },
  }
}

// ---------------------------------------------------------------------------
// system entries
// ---------------------------------------------------------------------------

function mapSystemEntry(entry: ClaudeEntry): CodexRolloutLine[] {
  if (entry.subtype === 'compact_boundary') {
    return [
      {
        timestamp: entry.timestamp,
        type: 'compacted',
        payload: (entry.compactMetadata ?? {}) as Record<string, unknown>,
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

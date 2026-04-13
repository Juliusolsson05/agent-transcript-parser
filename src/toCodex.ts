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

  return passthroughLine(entry)
}

function mapQueuedCommandAttachment(
  entry: ClaudeEntry,
  attachment: Record<string, unknown>,
): CodexRolloutLine[] {
  const prompt = typeof attachment.prompt === 'string' ? attachment.prompt.trim() : ''
  if (!prompt) return passthroughLine(entry)

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

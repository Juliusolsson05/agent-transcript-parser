// Codex rollout lines → Claude conversation entries.
//
// Short-circuits on `_atp.origin === 'claude'` for byte-identical
// round-trip when the input was previously converted from Claude.
// Otherwise dispatches on line.type + payload.type and emits one or
// more Claude entries per line, threading a mutable conversion
// context (sessionId, cwd, gitBranch, parentUuid, index) so every
// entry is stamped with stable, threading-consistent metadata.

import { attachSidecar, readSidecar } from './sidecar.js'
import { normalizeOutput, parseToolInput, stableUuid } from './util.js'
import type {
  ClaudeContentBlock,
  ClaudeEntry,
  ClaudeMessage,
  ClaudeTextBlock,
  ClaudeThinkingBlock,
  ClaudeToolResultBlock,
  ClaudeToolUseBlock,
  CodexCustomToolCallOutputPayload,
  CodexCustomToolCallPayload,
  CodexEventMsgPayload,
  CodexFunctionCallOutputPayload,
  CodexFunctionCallPayload,
  CodexLocalShellCallPayload,
  CodexMessagePayload,
  CodexReasoningPayload,
  CodexResponseItemPayload,
  CodexRolloutLine,
  CodexSessionMetaPayload,
  CodexTurnContextPayload,
  CodexWebSearchCallPayload,
} from './types.js'

export type ConvertOptions = {
  /** When true, do NOT embed _atp sidecars in output. Smaller files,
   *  but round-trip fidelity is lost for anything without a direct
   *  native equivalent. Default: false. */
  lossy?: boolean
  /** Optional target session id when synthesizing a Codex session_meta
   *  line in toCodex. Exposed from the shared options type because
   *  toCodex re-exports ConvertOptions from this file. Ignored by
   *  toClaude. */
  targetSessionId?: string
}

type Ctx = {
  sessionId: string
  cwd: string
  gitBranch: string
  version?: string
  parentUuid: string | null
  index: number
  lossy: boolean
  callInfo: Map<
    string,
    {
      assistantUuid: string
      claudeToolName?: string
      originalToolName: string
      input: unknown
    }
  >
}

function newCtx(lossy: boolean): Ctx {
  return {
    sessionId: '',
    cwd: '',
    gitBranch: '',
    version: undefined,
    parentUuid: null,
    index: 0,
    lossy,
    callInfo: new Map(),
  }
}

function summarizeToolCall(name: string, input: unknown): string {
  if (name === 'apply_patch') {
    const files = extractApplyPatchFiles(input)
    if (files.length > 0) {
      return `Applied patch touching ${files.join(', ')}.`
    }
    return 'Applied patch.'
  }
  if (name === 'parallel') {
    return 'Ran multiple tool calls in parallel.'
  }
  if (name === 'write_stdin') {
    return 'Sent input to an interactive command.'
  }
  return `Ran tool \`${name}\`.`
}

function summarizeToolResult(name: string, text: string, isError: boolean): string {
  const trimmed = text.trim()
  if (name === 'apply_patch') {
    return trimmed || (isError ? 'Patch application failed.' : 'Patch applied successfully.')
  }
  if (name === 'parallel') {
    return trimmed || (isError ? 'Parallel tool execution failed.' : 'Parallel tool execution completed.')
  }
  if (name === 'write_stdin') {
    return trimmed || (isError ? 'Interactive command input failed.' : 'Interactive command input completed.')
  }
  return trimmed || (isError ? `Tool \`${name}\` failed.` : `Tool \`${name}\` completed.`)
}

function mapToClaudeToolName(name: string): string | undefined {
  if (name === 'exec_command' || name === 'write_stdin') return 'Bash'
  return undefined
}

function toBashInput(input: unknown): Record<string, unknown> {
  if (isRecord(input)) {
    if (typeof input.cmd === 'string') {
      return {
        command: input.cmd,
        description: input.cmd,
      }
    }
    if (typeof input.chars === 'string') {
      return {
        command: input.chars,
        description: 'stdin input',
      }
    }
  }
  return {
    command: typeof input === 'string' ? input : JSON.stringify(input),
    description: 'shell command',
  }
}

function toBashToolUseResult(
  raw: unknown,
  normalizedText: string,
): Record<string, unknown> {
  const text = typeof raw === 'string' ? raw : normalizedText
  const exitCodeMatch = /Process exited with code (\d+)/.exec(text)
  const outputMatch = /\nOutput:\n([\s\S]*)$/.exec(text)
  return {
    stdout: outputMatch ? outputMatch[1] ?? '' : normalizedText,
    stderr: '',
    interrupted: false,
    ...(exitCodeMatch ? { returnCodeInterpretation: `exit ${exitCodeMatch[1]}` } : {}),
  }
}

function extractApplyPatchFiles(input: unknown): string[] {
  const text =
    typeof input === 'string'
      ? input
      : isRecord(input) && typeof input.arguments === 'string'
        ? input.arguments
        : ''
  if (text.length === 0) return []
  const files = new Set<string>()
  for (const line of text.split('\n')) {
    const m = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line.trim())
    if (m?.[1]) files.add(m[1])
  }
  return [...files]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Attach sidecar unless ctx.lossy. Also advances ctx.parentUuid +
 *  ctx.index so the next emit threads off this entry. Returns the
 *  possibly-decorated entry. */
function emit(
  ctx: Ctx,
  entry: ClaudeEntry,
  source: CodexRolloutLine,
): ClaudeEntry {
  const out = ctx.lossy ? entry : attachSidecar(entry, 'codex', source)
  ctx.parentUuid = entry.uuid
  ctx.index++
  return out
}

/** Stamp every Claude entry with the current context metadata (the
 *  fields that are position-dependent). Callers only build the shape
 *  they care about; this fills in the rest.
 *
 *  We spread `partial` LAST so caller-supplied fields (notably type
 *  and uuid) are authoritative; ctx contributes the threading
 *  metadata (parentUuid, sessionId, cwd, gitBranch) which the caller
 *  doesn't need to know about. */
function stamp(
  ctx: Ctx,
  partial: Omit<ClaudeEntry, 'parentUuid' | 'sessionId' | 'cwd' | 'gitBranch'> & {
    uuid: string
    timestamp: string
  },
): ClaudeEntry {
  return {
    parentUuid: ctx.parentUuid,
    isSidechain: false,
    userType: 'external',
    entrypoint: 'cli',
    sessionId: ctx.sessionId,
    cwd: ctx.cwd,
    gitBranch: ctx.gitBranch,
    ...(ctx.version ? { version: ctx.version } : {}),
    ...partial,
  }
}

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

export function toClaude(
  lines: readonly CodexRolloutLine[],
  opts: ConvertOptions = {},
): ClaudeEntry[] {
  const ctx = newCtx(opts.lossy === true)
  const out: ClaudeEntry[] = []

  // Dedup set for sidecar short-circuit. One Claude entry can split
  // into multiple Codex lines (a multi-block assistant turn becomes
  // one `message` + one `function_call`, sharing the same sidecar
  // source). Without deduping, the reverse trip would emit that
  // source once per line, bloating the output. Uuids are stable on
  // Claude entries, so uuid is the right dedup key.
  const seenSourceUuids = new Set<string>()

  for (const line of lines) {
    const sidecar = readSidecar(line)

    // Synthesized line — toCodex emitted it as boilerplate (prepended
    // session_meta, per-turn task_started / turn_context / task_complete
    // boundary wrappers, etc.). Absorb session_meta / turn_context
    // into context; drop all other synthesized lines entirely. Without
    // this short-circuit the round-trip would gain phantom sentinel
    // entries for every turn-wrap the converter inserted.
    if (sidecar?.origin === 'synthesized') {
      if (line.type === 'session_meta') {
        mapSessionMeta(ctx, line.payload as CodexSessionMetaPayload)
      } else if (line.type === 'turn_context') {
        mapTurnContext(ctx, line.payload as CodexTurnContextPayload)
      }
      // event_msg task_started / task_complete (and any future
      // synthesized line types) drop silently — they carry no
      // information beyond what the adjacent emitted entries already
      // carry via their own sidecars.
      continue
    }

    // Short-circuit: this Codex line already carries the original
    // Claude entry it came from. Emit that directly — byte-identical.
    if (sidecar?.origin === 'claude') {
      const source = sidecar.source
      if (source.uuid && seenSourceUuids.has(source.uuid)) {
        // Fan-out: same source already emitted by a previous line.
        // Skip silently — the already-emitted entry represents all
        // of these Codex lines collectively.
        continue
      }
      if (source.uuid) seenSourceUuids.add(source.uuid)
      out.push(source)
      ctx.parentUuid = source.uuid ?? ctx.parentUuid
      ctx.index++
      continue
    }

    const entries = mapLine(ctx, line)
    for (const entry of entries) {
      out.push(emit(ctx, entry, line))
    }
  }

  return out
}

// ---------------------------------------------------------------------------
// Per-line dispatcher
// ---------------------------------------------------------------------------

function mapLine(ctx: Ctx, line: CodexRolloutLine): ClaudeEntry[] {
  // atp_passthrough is a synthetic line type the toCodex side emits
  // for Claude entries with no native Codex equivalent (permission-
  // mode, file-history-snapshot, attachment, etc.). When the line
  // has a sidecar (fidelity mode), the short-circuit upstream
  // already restored the original Claude entry — we never reach
  // here. When there's no sidecar (lossy mode), the original is
  // genuinely lost and we drop the line silently. Same approach as
  // the unknown-type catch-all but more explicit.
  if (line.type === 'atp_passthrough') return []
  switch (line.type) {
    case 'session_meta': {
      mapSessionMeta(ctx, line.payload as CodexSessionMetaPayload)
      // Emit a sentinel system entry so the session_meta line has
      // somewhere to attach its sidecar. Without this, the line's
      // sidecar has no host and the Codex→Claude→Codex round-trip
      // loses the original session_meta bytes.
      return [
        stamp(ctx, {
          uuid: stableUuid([ctx.sessionId, ctx.index, line.timestamp, 'session_meta']),
          timestamp: line.timestamp,
          type: 'system',
          subtype: 'codex_session_meta',
        }),
      ]
    }
    case 'turn_context': {
      mapTurnContext(ctx, line.payload as CodexTurnContextPayload)
      return [
        stamp(ctx, {
          uuid: stableUuid([ctx.sessionId, ctx.index, line.timestamp, 'turn_context']),
          timestamp: line.timestamp,
          type: 'system',
          subtype: 'codex_turn_context',
        }),
      ]
    }
    case 'response_item':
      return mapResponseItem(
        ctx,
        line,
        line.payload as CodexResponseItemPayload,
      )
    case 'event_msg':
      return mapEventMsg(ctx, line, line.payload as CodexEventMsgPayload)
    case 'compacted':
      return [mapCompacted(ctx, line)]
    default:
      return mapUnknown(ctx, line)
  }
}

// ---------------------------------------------------------------------------
// Context-only mappers (no entries emitted)
// ---------------------------------------------------------------------------

function mapSessionMeta(ctx: Ctx, payload: CodexSessionMetaPayload): void {
  if (payload.id) ctx.sessionId = payload.id
  if (payload.cwd) ctx.cwd = payload.cwd
  if (payload.git?.branch) ctx.gitBranch = payload.git.branch
  if (payload.cli_version) ctx.version = payload.cli_version
}

function mapTurnContext(ctx: Ctx, payload: CodexTurnContextPayload): void {
  if (payload.cwd) ctx.cwd = payload.cwd
}

// ---------------------------------------------------------------------------
// response_item mappers
// ---------------------------------------------------------------------------

function mapResponseItem(
  ctx: Ctx,
  line: CodexRolloutLine,
  payload: CodexResponseItemPayload,
): ClaudeEntry[] {
  switch (payload.type) {
    case 'message':
      return mapMessage(ctx, line, payload as CodexMessagePayload)
    case 'function_call':
      return [mapFunctionCall(ctx, line, payload as CodexFunctionCallPayload)]
    case 'function_call_output':
      return [
        mapFunctionCallOutput(
          ctx,
          line,
          payload as CodexFunctionCallOutputPayload,
        ),
      ]
    case 'custom_tool_call':
      return [
        mapCustomToolCall(ctx, line, payload as CodexCustomToolCallPayload),
      ]
    case 'custom_tool_call_output':
      return mapCustomToolCallOutput(
        ctx,
        line,
        payload as CodexCustomToolCallOutputPayload,
      )
    case 'reasoning':
      return [mapReasoning(ctx, line, payload as CodexReasoningPayload)]
    case 'local_shell_call':
      return [
        mapLocalShellCall(ctx, line, payload as CodexLocalShellCallPayload),
      ]
    case 'web_search_call':
      return [mapWebSearchCall(ctx, line, payload as CodexWebSearchCallPayload)]
    default:
      return mapUnknown(ctx, line)
  }
}

function mapMessage(
  ctx: Ctx,
  line: CodexRolloutLine,
  payload: CodexMessagePayload,
): ClaudeEntry[] {
  const role: 'user' | 'assistant' =
    payload.role === 'user' ? 'user' : 'assistant'

  // Collect every text block into one Claude entry (matches Claude's
  // own JSONL: one entry per turn, multiple text blocks inside). If
  // the payload has no legible text content, skip it — the original
  // is preserved via sidecar for round-trip regardless.
  const blocks: ClaudeTextBlock[] = []
  for (const item of payload.content ?? []) {
    if (item.type === 'input_text' && typeof item.text === 'string') {
      blocks.push({ type: 'text', text: item.text })
    } else if (item.type === 'output_text' && typeof item.text === 'string') {
      blocks.push({ type: 'text', text: item.text })
    } else if (item.type === 'refusal' && typeof item.refusal === 'string') {
      blocks.push({ type: 'text', text: item.refusal })
    }
  }
  if (blocks.length === 0) return []

  const message: ClaudeMessage = {
    role,
    content: blocks,
    ...(payload.id ? { id: payload.id } : {}),
  }

  return [
    stamp(ctx, {
      uuid: stableUuid([ctx.sessionId, ctx.index, line.timestamp, 'message', role]),
      timestamp: line.timestamp,
      type: role,
      message,
    }),
  ]
}

function mapFunctionCall(
  ctx: Ctx,
  line: CodexRolloutLine,
  payload: CodexFunctionCallPayload,
): ClaudeEntry {
  const originalInput = parseToolInput(payload.arguments)
  const claudeToolName = mapToClaudeToolName(payload.name)
  const uuid = stableUuid([
    ctx.sessionId,
    ctx.index,
    line.timestamp,
    'function_call',
    payload.call_id,
  ])
  ctx.callInfo.set(payload.call_id, {
    assistantUuid: uuid,
    claudeToolName,
    originalToolName: payload.name,
    input: originalInput,
  })

  if (!claudeToolName) {
    return stamp(ctx, {
      uuid,
      timestamp: line.timestamp,
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: summarizeToolCall(payload.name, originalInput),
          },
        ],
      },
    })
  }

  const block: ClaudeToolUseBlock = {
    type: 'tool_use',
    id: payload.call_id,
    name: claudeToolName,
    input: claudeToolName === 'Bash' ? toBashInput(originalInput) : originalInput,
    ...(payload.namespace
      ? { codex: { namespace: payload.namespace } }
      : {}),
  }
  return stamp(ctx, {
    uuid,
    timestamp: line.timestamp,
    type: 'assistant',
    message: { role: 'assistant', content: [block] },
  })
}

function mapFunctionCallOutput(
  ctx: Ctx,
  line: CodexRolloutLine,
  payload: CodexFunctionCallOutputPayload,
): ClaudeEntry {
  const { text, metadata } = normalizeOutput(payload.output)
  const isError =
    metadata && typeof metadata.exit_code === 'number' && metadata.exit_code !== 0
  const callInfo = ctx.callInfo.get(payload.call_id)
  if (!callInfo?.claudeToolName) {
    return stamp(ctx, {
      uuid: stableUuid([
        ctx.sessionId,
        ctx.index,
        line.timestamp,
        'function_call_output_text',
        payload.call_id,
      ]),
      timestamp: line.timestamp,
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: summarizeToolResult(
              callInfo?.originalToolName ?? 'tool',
              text,
              Boolean(isError),
            ),
          },
        ],
      },
    })
  }

  const block: ClaudeToolResultBlock = {
    type: 'tool_result',
    tool_use_id: payload.call_id,
    content: text,
    ...(isError ? { is_error: true } : {}),
    ...(metadata ? { codex: { metadata } } : {}),
  }
  return stamp(ctx, {
    uuid: stableUuid([ctx.sessionId, ctx.index, line.timestamp, 'function_call_output', payload.call_id]),
    timestamp: line.timestamp,
    type: 'user',
    message: { role: 'user', content: [block] },
    sourceToolAssistantUUID: callInfo.assistantUuid,
    toolUseResult:
      callInfo.claudeToolName === 'Bash'
        ? toBashToolUseResult(payload.output, text)
        : undefined,
  })
}

function mapCustomToolCall(
  ctx: Ctx,
  line: CodexRolloutLine,
  payload: CodexCustomToolCallPayload,
): ClaudeEntry {
  const input = parseToolInput(payload.input)
  ctx.callInfo.set(payload.call_id, {
    assistantUuid: stableUuid([
      ctx.sessionId,
      ctx.index,
      line.timestamp,
      'custom_tool_call',
      payload.call_id,
    ]),
    originalToolName: payload.name,
    input,
  })
  return stamp(ctx, {
    uuid: stableUuid([ctx.sessionId, ctx.index, line.timestamp, 'custom_tool_call', payload.call_id]),
    timestamp: line.timestamp,
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: summarizeToolCall(payload.name, input),
        },
      ],
    },
  })
}

function mapCustomToolCallOutput(
  ctx: Ctx,
  line: CodexRolloutLine,
  payload: CodexCustomToolCallOutputPayload,
): ClaudeEntry[] {
  const { text, metadata } = normalizeOutput(payload.output)
  const isError =
    metadata && typeof metadata.exit_code === 'number' && metadata.exit_code !== 0
  const name = payload.name ?? ctx.callInfo.get(payload.call_id)?.originalToolName ?? 'tool'
  const out: ClaudeEntry[] = [
    stamp(ctx, {
      uuid: stableUuid([ctx.sessionId, ctx.index, line.timestamp, 'custom_tool_call_output', payload.call_id]),
      timestamp: line.timestamp,
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: summarizeToolResult(name, text, Boolean(isError)),
          },
        ],
      },
    }),
  ]

  if (name === 'apply_patch' && !isError) {
    const files = extractApplyPatchFiles(ctx.callInfo.get(payload.call_id)?.input)
    for (const file of files) {
      out.push(
        stamp(ctx, {
          uuid: stableUuid([
            ctx.sessionId,
            ctx.index,
            line.timestamp,
            'apply_patch_attachment',
            file,
          ]),
          timestamp: line.timestamp,
          type: 'attachment',
          attachment: {
            type: 'edited_text_file',
            filename: file,
            snippet: 'Updated via translated Codex patch.',
          },
        }),
      )
    }
  }

  return out
}

function mapReasoning(
  ctx: Ctx,
  line: CodexRolloutLine,
  payload: CodexReasoningPayload,
): ClaudeEntry {
  const text = (payload.summary ?? [])
    .map(s => (typeof s.text === 'string' ? s.text : ''))
    .filter(Boolean)
    .join('\n\n')
  const block: ClaudeThinkingBlock = {
    type: 'thinking',
    thinking: text,
    ...(payload.encrypted_content || payload.id
      ? {
          codex: {
            ...(payload.id ? { id: payload.id } : {}),
            ...(payload.encrypted_content
              ? { encrypted_content: payload.encrypted_content }
              : {}),
          },
        }
      : {}),
  }
  return stamp(ctx, {
    uuid: stableUuid([ctx.sessionId, ctx.index, line.timestamp, 'reasoning']),
    timestamp: line.timestamp,
    type: 'assistant',
    message: { role: 'assistant', content: [block] },
  })
}

function mapLocalShellCall(
  ctx: Ctx,
  line: CodexRolloutLine,
  payload: CodexLocalShellCallPayload,
): ClaudeEntry {
  const input =
    Array.isArray(payload.action?.command)
      ? {
          command: payload.action.command.join(' '),
          description: payload.action.command.join(' '),
          ...(typeof payload.action.working_directory === 'string'
            ? { workdir: payload.action.working_directory }
            : {}),
        }
      : payload.action?.cmd && Array.isArray(payload.action.cmd)
        ? {
            command: payload.action.cmd.join(' '),
            description: payload.action.cmd.join(' '),
            ...(typeof payload.action.workdir === 'string'
              ? { workdir: payload.action.workdir }
              : {}),
          }
        : payload.action
  const callId =
    payload.call_id ?? stableUuid([ctx.sessionId, ctx.index, 'local_shell_call'])
  ctx.callInfo.set(callId, {
    assistantUuid: stableUuid([ctx.sessionId, ctx.index, line.timestamp, 'local_shell_call']),
    claudeToolName: 'Bash',
    originalToolName: 'local_shell_call',
    input,
  })
  const block: ClaudeToolUseBlock = {
    type: 'tool_use',
    id: callId,
    name: 'Bash',
    input,
    codex: {
      kind: 'local_shell_call',
      ...(payload.status ? { status: payload.status } : {}),
    },
  }
  return stamp(ctx, {
    uuid: stableUuid([ctx.sessionId, ctx.index, line.timestamp, 'local_shell_call']),
    timestamp: line.timestamp,
    type: 'assistant',
    message: { role: 'assistant', content: [block] },
  })
}

function mapWebSearchCall(
  ctx: Ctx,
  line: CodexRolloutLine,
  payload: CodexWebSearchCallPayload,
): ClaudeEntry {
  const block: ClaudeToolUseBlock = {
    type: 'tool_use',
    id: stableUuid([ctx.sessionId, ctx.index, line.timestamp, 'web_search']),
    name: 'web_search',
    input: payload.action ?? {},
    codex: {
      kind: 'web_search_call',
      ...(payload.status ? { status: payload.status } : {}),
    },
  }
  return stamp(ctx, {
    uuid: stableUuid([ctx.sessionId, ctx.index, line.timestamp, 'web_search']),
    timestamp: line.timestamp,
    type: 'assistant',
    message: { role: 'assistant', content: [block] },
  })
}

// ---------------------------------------------------------------------------
// event_msg mappers
// ---------------------------------------------------------------------------

function mapEventMsg(
  ctx: Ctx,
  line: CodexRolloutLine,
  payload: CodexEventMsgPayload,
): ClaudeEntry[] {
  if (payload.type === 'exec_approval_request') {
    const p = payload as {
      type: 'exec_approval_request'
      call_id: string
      command: string[]
      workdir?: string
    }
    const lines = [
      'Permission required before running a command.',
      p.command.length > 0 ? `Command: ${p.command.join(' ')}` : null,
      p.workdir ? `Directory: ${p.workdir}` : null,
    ]
      .filter((l): l is string => l !== null)
      .join('\n')
    const block: ClaudeTextBlock = { type: 'text', text: lines }
    return [
      stamp(ctx, {
        uuid: stableUuid([ctx.sessionId, ctx.index, line.timestamp, 'exec_approval', p.call_id]),
        timestamp: line.timestamp,
        type: 'assistant',
        message: { role: 'assistant', content: [block] },
      }),
    ]
  }
  // Other event_msg types (task_started, task_complete, token_count,
  // exec_command_begin/end, etc.) are render-only lifecycle signals
  // with no native Claude equivalent. Emit a sentinel system entry so
  // the line's sidecar has somewhere to attach — without this,
  // Codex→Claude→Codex would lose every event_msg in the original
  // stream. The renderer treats codex_event_msg as metadata noise and
  // doesn't display it.
  return [
    stamp(ctx, {
      uuid: stableUuid([ctx.sessionId, ctx.index, line.timestamp, 'event_msg', payload.type]),
      timestamp: line.timestamp,
      type: 'system',
      subtype: 'codex_event_msg',
    }),
  ]
}

// ---------------------------------------------------------------------------
// Other top-level types
// ---------------------------------------------------------------------------

function mapCompacted(ctx: Ctx, line: CodexRolloutLine): ClaudeEntry {
  return stamp(ctx, {
    uuid: stableUuid([ctx.sessionId, ctx.index, line.timestamp, 'compacted']),
    timestamp: line.timestamp,
    type: 'system',
    subtype: 'compact_boundary',
    compactMetadata: line.payload as Record<string, unknown>,
  })
}

function mapUnknown(ctx: Ctx, line: CodexRolloutLine): ClaudeEntry[] {
  // Forward-compat catch-all: emit a synthetic system entry so
  // round-trip via sidecar still works. No visible content — the
  // renderer will treat it as metadata noise.
  return [
    stamp(ctx, {
      uuid: stableUuid([ctx.sessionId, ctx.index, line.timestamp, 'codex_unknown', line.type]),
      timestamp: line.timestamp,
      type: 'system',
      subtype: 'codex_unknown',
    }),
  ]
}

// Re-export the content block types so toCodex (and external
// consumers) don't need to dual-import from types.ts.
export type { ClaudeContentBlock }

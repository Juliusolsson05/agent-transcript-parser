// Codex codec: CodexRolloutLine[] ↔ NeutralTranscript.
//
// Skeleton, same disclaimer as ../codecs/claude.ts: passthrough-first,
// identity round-trip guaranteed, semantic surface (mapping
// response_item / event_msg / compacted payloads into the neutral
// entry union) is follow-up work.

import type { CodexRolloutLine, CodexSessionMetaPayload } from '../types.js'
import type {
  Codec,
  CodecEmitResult,
  EncodeOptions,
  NeutralContentBlock,
  NeutralEntry,
  NeutralHeader,
  NeutralIdentity,
  NeutralTranscript,
} from '../neutral/types.js'
import { EMPTY_REPORT } from '../neutral/types.js'
import { translateToCodex } from '../neutral/translate.js'

const CODEX_ID = 'codex' as const

function decode(source: CodexRolloutLine[]): NeutralTranscript {
  const header = deriveHeader(source)
  let userTurnOrdinal = -1

  const entries: NeutralEntry[] = source.map((raw, idx) => {
    const identity = deriveIdentity(raw, idx)

    // Turn ordinal: increment on the first `response_item message
    // role:user` per logical turn. rewindCodex.ts:132-141 documents
    // the "multiple user response_items per turn" hazard; matching
    // that logic keeps the neutral anchor addressable by the same
    // ordinal Codex's rewind uses.
    if (
      raw.type === 'response_item' &&
      isRecord(raw.payload) &&
      raw.payload.type === 'message' &&
      raw.payload.role === 'user'
    ) {
      userTurnOrdinal += 1
      identity.userTurnOrdinal = userTurnOrdinal
    }

    const passthrough = {
      provider: CODEX_ID,
      records: [raw] as unknown[],
      emissionOrder: [idx],
    }

    // Semantic mapping, slice 1 (#5). Codex ships tool calls and
    // results as SEPARATE rollout lines (unlike Claude's in-message
    // blocks), so they become standalone toolCall/toolResult entries.
    // Everything unmapped stays providerOpaque; passthrough remains
    // the encode source, so classification only improves.
    if (raw.type === 'session_meta') {
      return {
        kind: 'sessionMeta',
        ...identity,
        raw: { ...passthrough },
      }
    }
    if (raw.type === 'turn_context' && isRecord(raw.payload)) {
      const p = raw.payload as Record<string, unknown>
      return {
        kind: 'turnBoundary',
        ...identity,
        boundary: {
          turnId: typeof p.turn_id === 'string' ? p.turn_id : identity.id,
          startedAt: raw.timestamp ?? null,
          context: {
            ...(typeof p.cwd === 'string' ? { cwd: p.cwd } : {}),
            ...(typeof p.current_date === 'string' ? { currentDate: p.current_date } : {}),
            ...(typeof p.approval_policy === 'string'
              ? { approvalPolicy: p.approval_policy }
              : {}),
            ...(p.sandbox_policy !== undefined ? { sandboxPolicy: p.sandbox_policy } : {}),
            ...(typeof p.model === 'string' ? { model: p.model } : {}),
            ...(typeof p.personality === 'string' ? { personality: p.personality } : {}),
            ...(typeof p.summary === 'string' ? { summary: p.summary } : {}),
          },
        },
        raw: { ...passthrough },
      }
    }
    if (raw.type === 'response_item' && isRecord(raw.payload)) {
      const payload = raw.payload as Record<string, unknown>
      if (payload.type === 'message' && typeof payload.role === 'string') {
        const content = mapCodexMessageContent(payload)
        const base = {
          ...identity,
          content,
          raw: { ...passthrough },
          ...(typeof payload.phase === 'string' ? { phase: payload.phase } : {}),
        }
        if (payload.role === 'user') return { kind: 'userMessage', ...base }
        if (payload.role === 'assistant') return { kind: 'assistantMessage', ...base }
        // developer/system roles: semantically context injections;
        // keep opaque until a later slice maps them deliberately.
      }
      if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
        const rawArgs =
          typeof payload.arguments === 'string'
            ? payload.arguments
            : typeof payload.input === 'string'
              ? payload.input
              : undefined
        return {
          kind: 'toolCall',
          ...identity,
          block: {
            kind: 'toolUse',
            callId: typeof payload.call_id === 'string' ? payload.call_id : identity.id,
            toolName: typeof payload.name === 'string' ? payload.name : 'unknown',
            providerKind: payload.type,
            // Codex stores arguments as a JSON STRING that can be
            // parse-invalid — keep the wire bytes; parse best-effort.
            input: safeParseJson(rawArgs),
            ...(rawArgs !== undefined ? { rawArgumentsString: rawArgs } : {}),
            ...(typeof payload.namespace === 'string' ? { namespace: payload.namespace } : {}),
            ...(typeof payload.status === 'string' ? { status: payload.status } : {}),
          },
          raw: { ...passthrough },
        }
      }
      if (payload.type === 'local_shell_call') {
        const action = isRecord(payload.action) ? (payload.action as Record<string, unknown>) : {}
        const command = Array.isArray(action.command)
          ? action.command
          : Array.isArray(action.cmd)
            ? action.cmd
            : undefined
        return {
          kind: 'toolCall',
          ...identity,
          block: {
            kind: 'toolUse',
            callId: typeof payload.call_id === 'string' ? payload.call_id : identity.id,
            toolName: 'local_shell',
            providerKind: 'local_shell_call',
            input: { command },
            ...(typeof action.working_directory === 'string'
              ? { workdir: action.working_directory }
              : typeof action.workdir === 'string'
                ? { workdir: action.workdir }
                : {}),
            ...(typeof payload.status === 'string' ? { status: payload.status } : {}),
          },
          raw: { ...passthrough },
        }
      }
      if (
        payload.type === 'function_call_output' ||
        payload.type === 'custom_tool_call_output'
      ) {
        const output = payload.output
        const items = Array.isArray(output) ? (output as Array<Record<string, unknown>>) : null
        const firstMeta = items?.find(i => isRecord(i.metadata))?.metadata as
          | Record<string, unknown>
          | undefined
        return {
          kind: 'toolResult',
          ...identity,
          block: {
            kind: 'toolResult',
            callId: typeof payload.call_id === 'string' ? payload.call_id : identity.id,
            content:
              typeof output === 'string' && output.length > 0
                ? [{ kind: 'text', text: output }]
                : (items ?? [])
                    .filter(i => typeof i.text === 'string')
                    .map(i => ({ kind: 'text' as const, text: i.text as string })),
            ...(typeof firstMeta?.exit_code === 'number'
              ? { exitCode: firstMeta.exit_code, isError: firstMeta.exit_code !== 0 }
              : {}),
            ...(typeof firstMeta?.duration_seconds === 'number'
              ? { durationSeconds: firstMeta.duration_seconds }
              : {}),
            rawOutput: (output ?? '') as string | Array<Record<string, unknown>>,
          },
          raw: { ...passthrough },
        }
      }
      if (payload.type === 'reasoning') {
        const summary = Array.isArray(payload.summary)
          ? (payload.summary as Array<Record<string, unknown>>)
          : []
        return {
          kind: 'reasoning',
          ...identity,
          block: {
            kind: 'thinking',
            text: summary
              .map(s => (typeof s.text === 'string' ? s.text : ''))
              .filter(Boolean)
              .join('\n'),
            ...(typeof payload.id === 'string' ? { reasoningId: payload.id } : {}),
            ...(typeof payload.encrypted_content === 'string'
              ? { encryptedContent: payload.encrypted_content }
              : {}),
            ...(payload.content !== undefined ? { rawContent: payload.content } : {}),
            summaryItems: summary,
          },
          raw: { ...passthrough },
        }
      }
    }
    if (raw.type === 'event_msg' && isRecord(raw.payload)) {
      const payload = raw.payload as Record<string, unknown>
      if (
        payload.type === 'thread_name_updated' &&
        typeof payload.thread_name === 'string'
      ) {
        return {
          kind: 'titleChange',
          ...identity,
          title: payload.thread_name,
          raw: { ...passthrough },
        }
      }
      return {
        kind: 'lifecycleEvent',
        ...identity,
        eventType: String(payload.type ?? 'unknown'),
        payload,
        raw: { ...passthrough },
      }
    }
    if (raw.type === 'compacted') {
      return {
        kind: 'compaction',
        ...identity,
        summaryBody: isRecord(raw.payload) && typeof raw.payload.message === 'string'
          ? raw.payload.message
          : '',
        raw: { ...passthrough },
      }
    }
    return {
      kind: 'providerOpaque',
      ...identity,
      nativeType: raw.type,
      raw: { ...passthrough },
    }
  })

  return { header, entries }
}

// See the Claude codec's encode docstring — same identity/translate
// split (#5 slice 2).
function encode(
  neutral: NeutralTranscript,
  options: EncodeOptions = {},
): CodecEmitResult<CodexRolloutLine> {
  const foreign = neutral.entries.some(e => e.raw.provider !== CODEX_ID)
  if (foreign) {
    // targetSessionId forwards to the engine — Codex mints a fresh
    // rollout id by default (reusing the source id collides in
    // ~/.codex/sessions), and clone/switch flows need to pin it.
    const { lines, report } = translateToCodex(neutral, {
      ...(options.targetSessionId ? { targetSessionId: options.targetSessionId } : {}),
    })
    return { lines, report }
  }
  const lines: CodexRolloutLine[] = []
  for (const entry of neutral.entries) {
    for (const rec of entry.raw.records) {
      lines.push(rec as CodexRolloutLine)
    }
  }
  return { lines, report: EMPTY_REPORT }
}

function deriveHeader(source: CodexRolloutLine[]): NeutralHeader {
  let sessionId = ''
  let cwd: string | null = null
  let branch: string | null = null
  let commit: string | undefined
  let repositoryUrl: string | undefined
  let dirty: boolean | undefined
  let cliVersion: string | null = null
  let createdAt: string | null = null
  const extras: Record<string, unknown> = {}
  for (const raw of source) {
    if (raw.type === 'session_meta' && isSessionMetaPayload(raw.payload)) {
      const meta = raw.payload
      if (!sessionId && meta.id) sessionId = meta.id
      if (!cwd && meta.cwd) cwd = meta.cwd
      if (meta.git && isRecord(meta.git)) {
        if (!branch && typeof meta.git.branch === 'string') branch = meta.git.branch
        if (!commit && typeof meta.git.commit_hash === 'string') commit = meta.git.commit_hash
        if (!repositoryUrl && typeof meta.git.repository_url === 'string') {
          repositoryUrl = meta.git.repository_url
        }
        if (dirty === undefined && typeof meta.git.dirty === 'boolean') dirty = meta.git.dirty
      }
      if (!cliVersion && meta.cli_version) cliVersion = meta.cli_version
      if (!createdAt && (meta.timestamp ?? raw.timestamp)) {
        createdAt = meta.timestamp ?? raw.timestamp ?? null
      }
      // Codex header extras with no neutral home: originator, source,
      // model_provider, agent_nickname/role/path, forked_from_id,
      // memory_mode, base_instructions.
      for (const key of [
        'originator',
        'source',
        'model_provider',
        'agent_nickname',
        'agent_role',
        'agent_path',
        'forked_from_id',
        'memory_mode',
        'base_instructions',
      ]) {
        if (key in meta && !(key in extras)) {
          extras[key] = (meta as Record<string, unknown>)[key]
        }
      }
      break
    }
  }
  return {
    sessionId,
    createdAt,
    cwd,
    git: branch || commit || repositoryUrl || dirty !== undefined
      ? {
          ...(branch ? { branch } : {}),
          ...(commit ? { commit } : {}),
          ...(repositoryUrl ? { repositoryUrl } : {}),
          ...(dirty !== undefined ? { dirty } : {}),
        }
      : null,
    cliVersion,
    title: null,
    providerMeta: Object.keys(extras).length > 0 ? { codex: extras } : {},
  }
}

function deriveIdentity(raw: CodexRolloutLine, idx: number): NeutralIdentity {
  // Codex has no per-line uuid; synthesize a stable id from
  // timestamp + payload id/call_id/type + line index. Same recipe
  // historyLoader uses for its pagination markers.
  const payload: Record<string, unknown> = isRecord(raw.payload)
    ? (raw.payload as Record<string, unknown>)
    : {}
  const payloadId = typeof payload.id === 'string' ? payload.id : undefined
  const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined
  const payloadType = typeof payload.type === 'string' ? payload.type : undefined
  const parts: string[] = [
    'codex',
    String(idx),
    raw.timestamp ?? '',
    payloadId ?? callId ?? payloadType ?? raw.type,
  ]
  const id = parts.join(':')
  return {
    id,
    parentId: null,
    timestamp: raw.timestamp ?? '',
    userTurnOrdinal: null,
    providerIds: {
      codex: {
        ...(payloadId ? { itemId: payloadId } : {}),
        ...(callId ? { callId } : {}),
      },
    },
  }
}

function sniff(firstRecord: unknown): boolean {
  if (!firstRecord || typeof firstRecord !== 'object') return false
  const rec = firstRecord as Record<string, unknown>
  // Codex first record has an object `payload` and a string `type`.
  return (
    typeof rec.type === 'string' &&
    typeof rec.payload === 'object' &&
    rec.payload !== null
  )
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Map a Codex message payload's content items to neutral blocks.
 *  input_text/output_text → text; refusal → refusal. Annotations on
 *  output_text ride the passthrough (no neutral field yet). */
function mapCodexMessageContent(payload: Record<string, unknown>): NeutralContentBlock[] {
  const content = payload.content
  if (!Array.isArray(content)) return []
  const blocks: NeutralContentBlock[] = []
  for (const item of content as Array<Record<string, unknown>>) {
    if (
      (item.type === 'input_text' || item.type === 'output_text') &&
      typeof item.text === 'string'
    ) {
      blocks.push({ kind: 'text', text: item.text })
    } else if (item.type === 'refusal' && typeof item.refusal === 'string') {
      blocks.push({ kind: 'refusal', text: item.refusal })
    }
  }
  return blocks
}

/** Codex `arguments` is a JSON string that can be parse-invalid;
 *  parse best-effort and fall back to the raw string as the input so
 *  semantic consumers always see SOMETHING while `rawArgumentsString`
 *  keeps the authoritative bytes. */
function safeParseJson(input: string | undefined): unknown {
  if (input === undefined) return undefined
  try {
    return JSON.parse(input)
  } catch {
    return input
  }
}

function isSessionMetaPayload(v: unknown): v is CodexSessionMetaPayload {
  return isRecord(v) && typeof v.id === 'string'
}

export const CodexCodec: Codec<CodexRolloutLine> = {
  id: CODEX_ID,
  sniff,
  decode,
  encode,
}

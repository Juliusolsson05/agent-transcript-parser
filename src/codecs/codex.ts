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
  NeutralEntry,
  NeutralHeader,
  NeutralIdentity,
  NeutralTranscript,
} from '../neutral/types.js'
import { EMPTY_REPORT } from '../neutral/types.js'

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

    // Coarse kind mapping — the same "grow later" note applies here as
    // in the Claude codec.
    if (raw.type === 'session_meta') {
      return {
        kind: 'sessionMeta',
        ...identity,
        raw: { ...passthrough },
      }
    }
    if (raw.type === 'response_item' && isRecord(raw.payload)) {
      const payload = raw.payload
      if (payload.type === 'message' && payload.role === 'user') {
        return {
          kind: 'userMessage',
          ...identity,
          content: [],
          raw: { ...passthrough },
        }
      }
      if (payload.type === 'message' && payload.role === 'assistant') {
        return {
          kind: 'assistantMessage',
          ...identity,
          content: [],
          raw: { ...passthrough },
        }
      }
    }
    if (raw.type === 'event_msg' && isRecord(raw.payload)) {
      return {
        kind: 'lifecycleEvent',
        ...identity,
        eventType: String(raw.payload.type ?? 'unknown'),
        payload: raw.payload,
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

function encode(
  neutral: NeutralTranscript,
  _options: EncodeOptions = {},
): CodecEmitResult<CodexRolloutLine> {
  const lines: CodexRolloutLine[] = []
  for (const entry of neutral.entries) {
    if (entry.raw.provider !== CODEX_ID) continue
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

function isSessionMetaPayload(v: unknown): v is CodexSessionMetaPayload {
  return isRecord(v) && typeof v.id === 'string'
}

export const CodexCodec: Codec<CodexRolloutLine> = {
  id: CODEX_ID,
  sniff,
  decode,
  encode,
}

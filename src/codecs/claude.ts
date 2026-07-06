// Claude codec: ClaudeEntry[] ↔ NeutralTranscript.
//
// This is the SKELETON introduced by the first neutral-hub PR. Its
// current shape is passthrough-first: it stashes every source record
// verbatim in NeutralPassthrough and populates the neutral semantic
// fields conservatively — enough for downstream tooling to work
// against the neutral shape, enough to satisfy the same-provider
// identity round-trip guarantee, but explicitly NOT yet a full
// replacement for the semantic understanding baked into
// src/toClaude.ts and src/toCodex.ts.
//
// Growing the semantic surface (mapping tool_use blocks into
// NeutralToolUseBlock, thinking blocks into NeutralThinkingBlock,
// coalescing compact pairs, etc.) is deliberately deferred to
// follow-up PRs — this file's contract is "lossless decode / identity
// re-emit" and nothing more. Once the codecs cover the full semantic
// surface, toClaude.ts becomes a thin `encode(claude, decode(codex, x))`
// wrapper (see #5 §"Scope of work").

import type { ClaudeEntry } from '../types.js'
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

const CLAUDE_ID = 'claude' as const

/**
 * Decode a Claude JSONL stream into a NeutralTranscript.
 *
 * Lossless by construction: every source ClaudeEntry rides through
 * `NeutralPassthrough.records`. Neutral header + identity fields are
 * populated from the entry's own fields; unrecognized entry types
 * become `providerOpaque` so the encode side can round-trip them
 * verbatim.
 */
function decode(source: ClaudeEntry[]): NeutralTranscript {
  const header = deriveHeader(source)
  let userTurnOrdinal = -1
  let lastUserWasContiguous = false

  const entries: NeutralEntry[] = source.map((raw, idx) => {
    const identity = deriveIdentity(raw, idx)

    // Turn ordinal: increment on first user entry of a logical turn.
    // "Logical turn" is contiguous user entries with content (Claude's
    // rehydration can emit multiple user entries for one prompt when
    // attachments are involved) — matches the semantics rewindClaude
    // uses to anchor and what the neutral anchor promises across
    // providers.
    if (raw.type === 'user' && !raw.isMeta) {
      if (!lastUserWasContiguous) userTurnOrdinal += 1
      lastUserWasContiguous = true
      identity.userTurnOrdinal = userTurnOrdinal
    } else {
      lastUserWasContiguous = false
    }

    const passthrough = {
      provider: CLAUDE_ID,
      records: [raw] as unknown[],
      emissionOrder: [idx],
    }

    // Skeleton mapping: use a coarse kind derived from the wire type.
    // Growing this into the full semantic union (userMessage /
    // assistantMessage / toolCall / toolResult / reasoning /
    // compaction / titleChange / contextInjection / lifecycleEvent) is
    // follow-up work — for now everything that is not one of the
    // headline chat kinds becomes providerOpaque so encode can
    // round-trip it verbatim.
    if (raw.type === 'user') {
      return {
        kind: 'userMessage',
        ...identity,
        content: [],
        raw: { ...passthrough },
        ...(raw.isMeta !== undefined ? { isMeta: raw.isMeta } : {}),
      }
    }
    if (raw.type === 'assistant') {
      return {
        kind: 'assistantMessage',
        ...identity,
        content: [],
        raw: { ...passthrough },
      }
    }
    if (raw.type === 'custom-title' && raw.customTitle) {
      return {
        kind: 'titleChange',
        ...identity,
        title: raw.customTitle,
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

/**
 * Encode a NeutralTranscript back to a Claude JSONL stream.
 *
 * Same-provider identity path: for each neutral entry whose
 * passthrough came from Claude, re-emit the passthrough records
 * verbatim in their recorded emissionOrder. This makes
 * `encode(claude, decode(claude, x))` yield the same lines in the
 * same order as `x` — the round-trip identity guarantee this PR
 * exists to establish.
 *
 * Cross-provider path: not implemented in this skeleton — the entries
 * that came from Codex have no Claude representation yet. That work
 * lives in follow-up PRs (see the file header).
 */
function encode(
  neutral: NeutralTranscript,
  _options: EncodeOptions = {},
): CodecEmitResult<ClaudeEntry> {
  const lines: ClaudeEntry[] = []
  for (const entry of neutral.entries) {
    if (entry.raw.provider !== CLAUDE_ID) continue
    for (const rec of entry.raw.records) {
      lines.push(rec as ClaudeEntry)
    }
  }
  return { lines, report: EMPTY_REPORT }
}

function deriveHeader(source: ClaudeEntry[]): NeutralHeader {
  // Session id: Claude stamps every entry with `sessionId`; pick the
  // first non-empty. `cwd`/`gitBranch`/`version` similarly stamped
  // per-entry — first-seen wins.
  let sessionId = ''
  let cwd: string | null = null
  let branch: string | null = null
  let cliVersion: string | null = null
  let createdAt: string | null = null
  let title: string | null = null
  for (const raw of source) {
    if (!sessionId && raw.sessionId) sessionId = raw.sessionId
    if (!cwd && raw.cwd) cwd = raw.cwd
    if (!branch && raw.gitBranch) branch = raw.gitBranch
    if (!cliVersion && raw.version) cliVersion = raw.version
    if (!createdAt && raw.timestamp) createdAt = raw.timestamp
    if (!title && raw.type === 'custom-title' && raw.customTitle) {
      title = raw.customTitle
    }
    if (sessionId && cwd && branch && cliVersion && createdAt) break
  }
  return {
    sessionId,
    createdAt,
    cwd,
    git: branch ? { branch } : null,
    cliVersion,
    title,
    providerMeta: {},
  }
}

function deriveIdentity(raw: ClaudeEntry, idx: number): NeutralIdentity {
  return {
    id: raw.uuid ?? `claude-entry-${idx}`,
    parentId: raw.parentUuid ?? null,
    timestamp: raw.timestamp ?? '',
    userTurnOrdinal: null,
    providerIds: {
      claude: {
        uuid: raw.uuid,
        parentUuid: raw.parentUuid,
        ...(raw.message?.id ? { messageId: raw.message.id } : {}),
        ...(raw.requestId ? { requestId: raw.requestId } : {}),
      },
    },
  }
}

/**
 * Sniff a Claude JSONL: first record has `string uuid` and `string type`.
 * Mirrors detectFormat.ts's Claude check.
 */
function sniff(firstRecord: unknown): boolean {
  if (!firstRecord || typeof firstRecord !== 'object') return false
  const rec = firstRecord as Record<string, unknown>
  return typeof rec.uuid === 'string' && typeof rec.type === 'string'
}

export const ClaudeCodec: Codec<ClaudeEntry> = {
  id: CLAUDE_ID,
  sniff,
  decode,
  encode,
}

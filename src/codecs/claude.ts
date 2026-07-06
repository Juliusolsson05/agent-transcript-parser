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

import type { ClaudeContentBlock, ClaudeEntry } from '../types.js'
import type {
  Codec,
  CodecEmitResult,
  EncodeOptions,
  NeutralContentBlock,
  NeutralEntry,
  NeutralHeader,
  NeutralIdentity,
  NeutralTranscript,
  NeutralUsage,
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
    // providers. isMeta (bootstrap housekeeping) and isCompactSummary
    // (synthetic compaction text, type 'user' on the wire but not a
    // human prompt) are excluded — counting them would let the
    // neutral anchor drift from what a human counts as "my Nth
    // prompt", which is exactly the ordinal's contract.
    if (raw.type === 'user' && !raw.isMeta && !raw.isCompactSummary) {
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

    // Semantic mapping, slice 1 (#5): the headline chat kinds carry
    // real content now. Claude nests tool_use/tool_result blocks
    // INSIDE messages (unlike Codex's separate lines), so this codec
    // never emits standalone toolCall/toolResult entries — the blocks
    // live in the message's content array. Everything unmapped stays
    // providerOpaque; the passthrough region remains the encode source
    // regardless, so classification can only improve, never lose.
    if (raw.type === 'user') {
      return {
        kind: 'userMessage',
        ...identity,
        content: mapClaudeContent(raw),
        raw: { ...passthrough },
        ...(raw.isMeta !== undefined ? { isMeta: raw.isMeta } : {}),
        ...(raw.isCompactSummary !== undefined
          ? { isCompactSummary: raw.isCompactSummary }
          : {}),
        ...(raw.isSidechain !== undefined ? { isSidechain: raw.isSidechain } : {}),
      }
    }
    if (raw.type === 'assistant') {
      const usage = raw.message?.usage
        ? ({
            ...(raw.message.usage as Record<string, unknown>),
            ...(raw.message.model ? { model: raw.message.model } : {}),
            ...(raw.message.stop_reason !== undefined
              ? { stopReason: raw.message.stop_reason }
              : {}),
          } as NeutralUsage)
        : undefined
      return {
        kind: 'assistantMessage',
        ...identity,
        content: mapClaudeContent(raw),
        ...(usage ? { usage } : {}),
        raw: { ...passthrough },
        ...(raw.isSidechain !== undefined ? { isSidechain: raw.isSidechain } : {}),
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
    if (raw.type === 'system' && raw.subtype === 'compact_boundary') {
      return {
        kind: 'compaction',
        ...identity,
        // The boundary itself carries no summary text; the paired
        // isCompactSummary user entry does (it stays a userMessage
        // with the flag — coalescing the PAIR into one neutral entry
        // is a later slice; both classifications are lossless because
        // encode reads passthrough).
        summaryBody: '',
        boundaryId: identity.id,
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
 * Map a Claude message's content into neutral blocks. String content
 * is a single text block; block arrays map per-type with the raw
 * preservation rules from #5 §7 (toolResult keeps the verbatim wire
 * content in `rawOutput` because downstream normalizers are
 * heuristic; thinking keeps the unfabricatable `signature`).
 * Unknown block types degrade to a text block with empty text —
 * their full payload still rides the entry's passthrough region, so
 * nothing is lost; they're just invisible to semantic consumers until
 * a later slice maps them.
 */
function mapClaudeContent(raw: ClaudeEntry): NeutralContentBlock[] {
  const content = raw.message?.content
  if (typeof content === 'string') {
    return content.length > 0 ? [{ kind: 'text', text: content }] : []
  }
  if (!Array.isArray(content)) return []
  const blocks: NeutralContentBlock[] = []
  for (const block of content as ClaudeContentBlock[]) {
    if (block.type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
      blocks.push({ kind: 'text', text: (block as { text: string }).text })
      continue
    }
    if (block.type === 'tool_use') {
      const b = block as Extract<ClaudeContentBlock, { type: 'tool_use' }>
      blocks.push({
        kind: 'toolUse',
        callId: b.id,
        toolName: b.name,
        providerKind: 'tool_use',
        input: b.input,
      })
      continue
    }
    if (block.type === 'tool_result') {
      const b = block as Extract<ClaudeContentBlock, { type: 'tool_result' }>
      blocks.push({
        kind: 'toolResult',
        callId: b.tool_use_id,
        content:
          typeof b.content === 'string' && b.content.length > 0
            ? [{ kind: 'text', text: b.content }]
            : [],
        ...(b.is_error !== undefined ? { isError: b.is_error } : {}),
        rawOutput: typeof b.content === 'string' ? b.content : (b.content as Array<Record<string, unknown>>),
        ...(raw.toolUseResult ? { structuredResult: raw.toolUseResult } : {}),
      })
      continue
    }
    if (block.type === 'thinking') {
      const b = block as Extract<ClaudeContentBlock, { type: 'thinking' }>
      blocks.push({
        kind: 'thinking',
        text: b.thinking,
        ...(b.signature ? { signature: b.signature } : {}),
      })
      continue
    }
    // Unknown block type: invisible semantically, preserved via the
    // entry's passthrough.
  }
  return blocks
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

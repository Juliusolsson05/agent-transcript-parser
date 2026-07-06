// NeutralTranscript: the C in A↔C↔B.
//
// Issue #5 (agent-transcript-parser) captured the "why" — this file is
// the type shape derived from that audit: the union of everything the
// existing toClaude/toCodex converters demonstrably read and write.
//
// Guiding constraints (from #5 §2 and §7):
//
// 1. LOSSLESS by construction. Any provider-specific field with no
//    neutral semantic MUST ride in the per-entry `raw` passthrough
//    region — never dropped by decode. The lossy set is exclusively
//    what CROSS-provider encode explicitly cannot map, and it's
//    reported (not silently dropped) via CodecReport.
//
// 2. Same-provider round-trip is IDENTITY. `encode(P, decode(P, x))`
//    reproduces `x` semantically, including entry ordering, ids,
//    timestamps, tool-call/result pairing, thinking signatures,
//    permission-mode entries, session_meta extras — everything.
//
// 3. Neutral anchoring subsumes the two leaked anchor types
//    (`{uuid}` vs `{userMessageIndex}`) — one address, any provider.
//
// This module deliberately declares TYPES ONLY. Codec implementations
// live in ../codecs/. Keeping the shape file free of runtime code
// makes it a small, stable target for downstream consumers (agent-code
// phase 5) to depend on.

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

/**
 * Transcript-level metadata. Absorbs BOTH Claude's per-entry stamping
 * (session id, cwd, gitBranch, version) AND Codex's session_meta
 * payload. Codec extras (originator/source/model_provider/git.commit
 * hash/dirty/agent_nickname/forked_from_id/memory_mode etc.) that have
 * no neutral semantic go on `providerMeta.raw` so decode is lossless.
 */
export type NeutralHeader = {
  /** Neutral session id. On decode, provider file/session ids are
   *  preserved verbatim under `providerIds`; this is the canonical
   *  handle downstream tooling uses when it doesn't care which
   *  provider originated the transcript. */
  sessionId: string
  /** ISO-8601 of the first meaningful entry (session_meta timestamp
   *  for Codex; first entry timestamp for Claude if no explicit
   *  session-start marker). */
  createdAt: string | null
  cwd: string | null
  /** Structured git metadata. All fields optional — Claude only
   *  carries `branch`; Codex may carry commit/repository/dirty. */
  git: {
    branch?: string
    commit?: string
    repositoryUrl?: string
    dirty?: boolean
  } | null
  cliVersion: string | null
  /** Custom title (Claude `custom-title` entry ↔ Codex
   *  `thread_name_updated` event). One of the few metadata pairs
   *  already round-trip mapped by the pairwise converters. */
  title: string | null
  /** Free-form container for provider-specific header extras that
   *  don't map to a neutral field but MUST survive same-provider
   *  round-trip. Keyed by AgentProviderId so a caller can inspect
   *  what a specific provider stamped. */
  providerMeta: Partial<Record<AgentProviderId, Record<string, unknown>>>
}

// ---------------------------------------------------------------------------
// Identity / addressing (the neutral anchor)
// ---------------------------------------------------------------------------

export type AgentProviderId = 'claude' | 'codex'

/**
 * Per-provider identity carried on every entry. Populated by decode
 * for whichever provider produced the entry; encode reads BACK the
 * matching side (Claude codec reads `providerIds.claude`, Codex
 * codec reads `providerIds.codex`) so cloning and re-emission stay
 * byte-stable.
 */
export type NeutralProviderIds = {
  claude?: {
    uuid: string
    parentUuid: string | null
    messageId?: string
    requestId?: string
  }
  codex?: {
    /** `response_item.payload.id` when the item carries one. */
    itemId?: string
    /** `call_id` on function_call / tool result pairing. */
    callId?: string
    /** Synthetic per-turn id from Codex's turn wrapping. */
    turnId?: string
  }
}

/**
 * Neutral entry-level identity. `id` is the stable per-entry key
 * downstream tooling uses (memoization, dedupe, cross-transcript
 * reference); it is deterministic per decoded record so re-decoding
 * the same source produces the same `id`.
 *
 * `userTurnOrdinal` is the neutral anchor: zero-based count of REAL
 * user prompts in document order. Subsumes Codex's `userMessageIndex`
 * — Claude's rewind anchor becomes `{userTurnOrdinal}` too, killing
 * the leaked `{kind:'claude';uuid} | {kind:'codex';userMessageIndex}`
 * union in agent-code's preload/renderer. See #5 §3 rewind semantics.
 *
 * WHY it counts LOGICAL prompts (not response_items): Codex can
 * emit multiple `message role:user` items in one logical turn
 * (rewindCodex.ts:132-141 documents the hazard). The counter here
 * increments only on the FIRST user entry of a logical turn — see
 * ClaudeCodec/CodexCodec for the exact rule.
 */
export type NeutralIdentity = {
  id: string
  parentId: string | null
  timestamp: string
  userTurnOrdinal: number | null
  providerIds: NeutralProviderIds
}

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

export type NeutralTextBlock = { kind: 'text'; text: string }
export type NeutralRefusalBlock = { kind: 'refusal'; text: string }
export type NeutralImageBlock = {
  kind: 'image'
  mediaType: string
  source?: unknown
  data?: string
}
export type NeutralDocumentBlock = {
  kind: 'document'
  title?: string
  source?: unknown
}
export type NeutralSearchResultBlock = {
  kind: 'searchResult'
  title?: string
  url?: string
  snippet?: string
}

/**
 * Structured tool-use block. The `providerKind` field preserves how
 * the provider modeled the call (Claude's tool_use vs Codex's
 * function_call / custom_tool_call / local_shell_call /
 * web_search_call / tool_search_call) so encode picks the right
 * on-the-wire shape. Fields absent on one provider (`namespace`,
 * `workdir`, `status`, `timeout`, `env`) are optional here; codecs
 * that don't need them ignore them.
 *
 * `rawArgumentsString` is deliberate: Codex stores arguments as a
 * JSON string that CAN be parse-invalid; keeping the wire bytes
 * around lets encode-back-to-Codex reproduce the original even if
 * `input` failed to parse. Claude decode leaves this undefined.
 */
export type NeutralToolUseBlock = {
  kind: 'toolUse'
  callId: string
  toolName: string
  providerKind:
    | 'tool_use'
    | 'function_call'
    | 'custom_tool_call'
    | 'local_shell_call'
    | 'web_search_call'
    | 'tool_search_call'
  input: unknown
  rawArgumentsString?: string
  namespace?: string
  status?: string
  workdir?: string
  timeoutMs?: number
  env?: Record<string, string>
}

/**
 * Structured tool-result block. `rawOutput` keeps the verbatim wire
 * payload (string OR item array) — `normalizeOutput` and
 * `toBashToolUseResult` in toClaude are heuristic parsers, and
 * losing their input to those heuristics breaks lossless round-trip.
 * `structuredResult` carries Claude's `toolUseResult` field which
 * has no Codex analogue but IS load-bearing for Claude renderers.
 */
export type NeutralToolResultBlock = {
  kind: 'toolResult'
  callId: string
  content: NeutralContentBlock[]
  isError?: boolean
  exitCode?: number
  durationSeconds?: number
  metadata?: Record<string, unknown>
  rawOutput?: string | Array<Record<string, unknown>>
  structuredResult?: Record<string, unknown>
}

/**
 * Reasoning / thinking. `signature` is CLAUDE-ONLY and cannot be
 * fabricated (Anthropic's API rejects unsigned thinking blocks —
 * see toClaude.ts:1079-1103's why-comment). Cross-provider encode
 * to Claude that lacks a signature must demote to text (matching
 * toClaude's existing behavior); this is reported via
 * CodecReport.demoted, not silently dropped.
 */
export type NeutralThinkingBlock = {
  kind: 'thinking'
  text: string
  signature?: string
  reasoningId?: string
  encryptedContent?: string
  /** Verbatim structured `content` field from Codex reasoning items,
   *  which is Codex-side proprietary and unused by Claude. */
  rawContent?: unknown
  /** Verbatim summary items array from Codex reasoning — kept for
   *  same-provider round-trip. */
  summaryItems?: Array<Record<string, unknown>>
}

export type NeutralContentBlock =
  | NeutralTextBlock
  | NeutralRefusalBlock
  | NeutralImageBlock
  | NeutralDocumentBlock
  | NeutralSearchResultBlock
  | NeutralToolUseBlock
  | NeutralToolResultBlock
  | NeutralThinkingBlock

// ---------------------------------------------------------------------------
// Entry-level flags and metadata
// ---------------------------------------------------------------------------

export type NeutralUsage = {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  model?: string
  stopReason?: string | null
  stopSequence?: string | null
} & Record<string, unknown>

export type NeutralEntryFlags = {
  isMeta?: boolean
  isSidechain?: boolean
  isCompactSummary?: boolean
  isVisibleInTranscriptOnly?: boolean
  isBootstrap?: boolean
  permissionMode?: string
  userType?: string
  entrypoint?: string
  slug?: string
  promptId?: string
  phase?: 'commentary' | 'final_answer' | string
  endTurn?: boolean
  sourceToolAssistantRef?: string
}

// ---------------------------------------------------------------------------
// Turn structure
// ---------------------------------------------------------------------------

/**
 * Turn context. Needed for lossless Codex round-trip AND so encode
 * to Codex stops fabricating defaults (`model:'gpt-5'`,
 * `approval_policy:'on-request'`, etc. — see toCodex.ts:297-345) when
 * real values exist in the source.
 */
export type NeutralTurnBoundary = {
  turnId: string
  startedAt: string | null
  context: {
    cwd?: string
    currentDate?: string
    timezone?: string
    approvalPolicy?: string
    sandboxPolicy?: unknown
    model?: string
    personality?: string
    summary?: string
    collaborationMode?: string
    modelContextWindow?: number
  } | null
  lastAgentMessage?: string
}

// ---------------------------------------------------------------------------
// Passthrough region (the lossless guarantee)
// ---------------------------------------------------------------------------

/**
 * Per-entry passthrough. `records` is an ARRAY because the mapping
 * between neutral entries and provider records is provably N:M:
 *
 * - toClaude coalesces N Codex response_items into 1 Claude entry.
 * - toCodex fans 1 Claude entry into 2+ Codex lines (dual event_msg
 *   + response_item emission).
 * - Compact pair 2→1: Claude's boundary + summary → one Codex
 *   compacted line.
 *
 * `emissionOrder` preserves the original line indices from the
 * source file so identity round-trip reproduces line order exactly.
 * `provider` names which side the records came from so encode
 * knows whether to trust them as authoritative or as "hints only".
 */
export type NeutralPassthrough = {
  provider: AgentProviderId
  records: unknown[]
  emissionOrder?: number[]
}

// ---------------------------------------------------------------------------
// Neutral entry
// ---------------------------------------------------------------------------

/**
 * A single logical transcript entry, discriminated by `kind`. This
 * union covers everything both existing converters read/write.
 *
 * WHY `providerOpaque` exists: some non-chat entry types (Claude's
 * permission-mode, file-history-snapshot, queue-operation, last-prompt,
 * mode, worktree-state, content-replacement, attribution-snapshot,
 * plus Codex event_msg families with no cross-provider meaning) have
 * no semantic across providers. Instead of dropping them or forcing
 * awkward "meta" wrapping, `providerOpaque` carries the raw record
 * with only a native-type marker. Same-provider encode re-emits it
 * verbatim; cross-provider encode drops it and reports the drop.
 */
export type NeutralEntry =
  | ({
      kind: 'userMessage'
      content: NeutralContentBlock[]
      raw: NeutralPassthrough
    } & NeutralIdentity & NeutralEntryFlags)
  | ({
      kind: 'assistantMessage'
      content: NeutralContentBlock[]
      usage?: NeutralUsage
      raw: NeutralPassthrough
    } & NeutralIdentity & NeutralEntryFlags)
  | ({
      kind: 'toolCall'
      block: NeutralToolUseBlock
      raw: NeutralPassthrough
    } & NeutralIdentity & NeutralEntryFlags)
  | ({
      kind: 'toolResult'
      block: NeutralToolResultBlock
      raw: NeutralPassthrough
    } & NeutralIdentity & NeutralEntryFlags)
  | ({
      kind: 'reasoning'
      block: NeutralThinkingBlock
      raw: NeutralPassthrough
    } & NeutralIdentity & NeutralEntryFlags)
  | ({
      kind: 'compaction'
      summaryBody: string
      trigger?: string
      preTokens?: number
      replacementHistoryReplayUnsafe?: boolean
      boundaryId?: string
      summaryId?: string
      raw: NeutralPassthrough
    } & NeutralIdentity & NeutralEntryFlags)
  | ({
      kind: 'sessionMeta'
      raw: NeutralPassthrough
    } & NeutralIdentity)
  | ({
      kind: 'turnBoundary'
      boundary: NeutralTurnBoundary
      raw: NeutralPassthrough
    } & NeutralIdentity)
  | ({
      kind: 'titleChange'
      title: string
      raw: NeutralPassthrough
    } & NeutralIdentity)
  | ({
      kind: 'contextInjection'
      /** Claude attachment families + Codex approval/exec events. */
      attachmentType: string
      payload: Record<string, unknown>
      raw: NeutralPassthrough
    } & NeutralIdentity & NeutralEntryFlags)
  | ({
      kind: 'lifecycleEvent'
      eventType: string
      payload: Record<string, unknown>
      raw: NeutralPassthrough
    } & NeutralIdentity)
  | ({
      kind: 'providerOpaque'
      nativeType: string
      raw: NeutralPassthrough
    } & NeutralIdentity & NeutralEntryFlags)

// ---------------------------------------------------------------------------
// The transcript
// ---------------------------------------------------------------------------

export type NeutralTranscript = {
  header: NeutralHeader
  entries: NeutralEntry[]
}

// ---------------------------------------------------------------------------
// Codec contract
// ---------------------------------------------------------------------------

/**
 * A codec is a per-provider decode+encode pair. Adding provider N+1
 * costs ONE codec (2 functions), not N direct pairwise converters.
 * All cross-provider operations become `encode(target, decode(source))`.
 *
 * `sniff` lets a codec self-describe how to detect its own format —
 * detectFormat.ts's hand-rolled two-way check moves onto the codec
 * registry.
 */
export interface Codec<TSource> {
  readonly id: AgentProviderId
  /** Recognize this codec's format from the first record. */
  sniff(firstRecord: unknown): boolean
  /** LOSSLESS decode. Everything the codec doesn't have a neutral
   *  semantic for must ride in `NeutralPassthrough.records` and the
   *  transcript's `providerMeta` region. */
  decode(source: TSource[]): NeutralTranscript
  /** Encode back to the codec's provider format. Returns the emitted
   *  lines PLUS a report of what was dropped/demoted/synthesized so
   *  cross-provider callers can inspect the loss set instead of
   *  discovering it at renderer time. */
  encode(neutral: NeutralTranscript, options?: EncodeOptions): CodecEmitResult<TSource>
}

export type EncodeOptions = {
  /** If true, drop the passthrough region rather than re-emitting it
   *  verbatim on same-provider encode. Reserved for callers that
   *  intentionally want a "clean" re-emission (e.g. sanitize-for-
   *  resume flows). Default false. */
  omitPassthrough?: boolean
  /** Optional target session id for encode. Cloning flows set this to
   *  a fresh uuid; identity round-trip leaves it undefined so the
   *  codec preserves the source id. */
  targetSessionId?: string
}

export type CodecEmitResult<TSource> = {
  lines: TSource[]
  report: CodecReport
}

/**
 * Report of what wasn't a clean transfer. Empty on same-provider
 * identity round-trip by construction. On cross-provider encode,
 * populated with structured entries so callers can display, log, or
 * hard-fail on them instead of shipping silent data loss.
 */
export type CodecReport = {
  /** Fields or entries that had NO representation in the target
   *  provider and were dropped from the emitted output. Their
   *  content still lives in the neutral transcript's passthrough
   *  region — this array is a policy-level notice, not a data-loss
   *  event (data is preserved neutrally). */
  dropped: Array<{
    entryId: string
    reason: string
    field?: string
  }>
  /** Fields the target provider requires but the neutral transcript
   *  couldn't source (e.g. Codex `model_provider`, Claude thinking
   *  `signature`). Recorded so callers can decide whether to reject
   *  the encode or accept the synthesis. */
  synthesized: Array<{
    entryId?: string
    field: string
    reason: string
  }>
  /** Blocks that were demoted from a richer to a poorer kind because
   *  the target can't express the source (e.g. Codex `reasoning` →
   *  Claude `text` when signature is absent). */
  demoted: Array<{
    entryId: string
    fromKind: string
    toKind: string
    reason: string
  }>
}

/** Convenience: empty report. Codecs return this on lossless emit. */
export const EMPTY_REPORT: CodecReport = {
  dropped: [],
  synthesized: [],
  demoted: [],
}

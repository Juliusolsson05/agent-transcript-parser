import type {
  ConversationCompaction,
  ConversationDocument,
  ConversationMessage,
  ConversationOpaque,
  ProviderId,
} from '../conversation/types.js'

export const CLAUDE_COMPACTION_PLACEHOLDER = 'Conversation compacted'

export type CompactionAvailability = 'portable' | 'native-only' | 'incomplete' | 'rejected'

// WHY these prefixes are a parser constant: Claude Code writes its rate-limit
// message as an ordinary assistant record whose text starts with one of these
// (services/rateLimitMessages.ts RATE_LIMIT_ERROR_PREFIXES, byte-identical to
// this list). Its own compaction only rejects summaries starting with
// "API Error", so a limit hit during /compact can plausibly persist this text
// as the summary. Any host that accepted such a carrier would switch with the
// history destroyed (#820).
export const CLAUDE_RATE_LIMIT_PREFIXES = [
  "You've hit your",
  "You've used",
  "You're now using extra usage",
  "You're close to",
  "You're out of extra usage",
] as const

/**
 * Decide whether a persisted compaction carrier is really a rate-limit message.
 *
 * WHY this matches at any line start instead of only at position 0, which is
 * what Claude Code's own `isRateLimitErrorMessage` does: the two functions do
 * not see the same string. Claude's guard runs on the raw model summary, before
 * `getCompactUserSummaryMessage` (vendor/claude-code-src/full/services/compact/
 * prompt.ts:337-346) unconditionally wraps it in
 *
 *   "This session is being continued from a previous conversation that ran out
 *    of context. The summary below covers the earlier portion of the
 *    conversation.\n\n<formatted summary>"
 *
 * and all three carrier-writing sites go through that wrapper (compact.ts:616,
 * compact.ts:1033, sessionMemoryCompact.ts:464). The parser only ever sees the
 * wrapped, persisted record, so the limit text lands roughly 150 characters in,
 * behind that preamble and usually behind a "Summary:" header line as well.
 * A `startsWith` check on the carrier would therefore never fire on the exact
 * artifact this guard exists to catch. The Stage 0 census independently
 * confirms the shape: the one real post-limit carrier in the corpus begins
 * "This session is being continued from a previous conversation that ran out
 * of context."
 *
 * The cost of the wider match is a false `rejected` on a genuine summary that
 * happens to open a line with "You've used" — that costs one raw-history carry.
 * The cost of missing one is a switch that destroys the conversation, so the
 * asymmetry is deliberate.
 */
export function isRateLimitText(text: string): boolean {
  for (const line of text.split('\n')) {
    const trimmed = line.trimStart()
    if (CLAUDE_RATE_LIMIT_PREFIXES.some(prefix => trimmed.startsWith(prefix))) return true
  }
  return false
}

/**
 * Find the first API-error record after a baseline transcript line.
 *
 * WHY a host needs this: the opt-in "compact on the source first" path issues
 * `/compact` and then waits for a new boundary. If the provider answered with
 * a limit instead, the wait would otherwise run to its timeout, or worse,
 * accept whatever landed. A line-addressed lookup lets the caller fail fast on
 * exactly the records written after its own baseline, without retaining a
 * `ConversationDocument` across awaits (the #720 retention discipline).
 */
export function findApiErrorAfterLine(
  conversation: ConversationDocument,
  baselineLine: number,
): ConversationOpaque | null {
  for (const entry of conversation.entries) {
    if (entry.kind !== 'opaque' || entry.nativeType !== 'api_error') continue
    if (entry.source.line > baselineLine) return entry
  }
  return null
}

export interface CompactionDescription {
  entry: ConversationCompaction
  entryIndex: number
  availability: CompactionAvailability
  fingerprint: string
}

export interface PortableCodexHandoff {
  summary: string
  message: ConversationMessage
  completionLine: number
}

export interface CompactionPortability {
  nativeSummaryIsPortable: boolean
  requiresPlaintextHandoffTurn: boolean
}

export function compactionPortability(
  sourceProvider: ProviderId,
  targetProvider: ProviderId,
): CompactionPortability {
  if (sourceProvider === targetProvider) {
    return {
      nativeSummaryIsPortable: true,
      requiresPlaintextHandoffTurn: false,
    }
  }

  // WHY this rule belongs in the parser: it follows from provider persistence,
  // not from any Electron or PTY lifecycle. Claude writes a plaintext carrier;
  // Codex writes provider-authenticated encrypted replacement history. Every
  // host application needs the same answer before it decides which live step
  // to execute.
  return sourceProvider === 'claude'
    ? { nativeSummaryIsPortable: true, requiresPlaintextHandoffTurn: false }
    : { nativeSummaryIsPortable: false, requiresPlaintextHandoffTurn: true }
}

export function describeLatestCompaction(
  conversation: ConversationDocument,
): CompactionDescription | null {
  for (let entryIndex = conversation.entries.length - 1; entryIndex >= 0; entryIndex -= 1) {
    const entry = conversation.entries[entryIndex]
    if (entry?.kind !== 'compaction') continue
    const availability = compactionAvailability(entry)
    return {
      entry,
      entryIndex,
      availability,
      fingerprint: `${entry.source.provider}:${entry.source.line}:${availability}:${entry.summary}`,
    }
  }
  return null
}

export function conversationAfterLatestPortableCompaction(
  conversation: ConversationDocument,
): ConversationDocument {
  const latest = describeLatestCompaction(conversation)
  // WHY the test is `!== 'portable'` rather than a list of bad values: every
  // availability other than `portable` — `native-only`, `incomplete` and now
  // `rejected` — means the same thing here, that the pre-compaction turns must
  // be kept because no plaintext summary can stand in for them. Adding a
  // `rejected` branch would only create a second place to forget a future
  // value.
  if (!latest || latest.availability !== 'portable') return conversation

  // WHY the provider-authored summary replaces everything before it: native
  // resume no longer sends those pre-compaction turns to the model. Keeping
  // them in a translated session both changes semantics and double-counts the
  // very context the source provider deliberately evicted.
  return {
    ...conversation,
    entries: conversation.entries.slice(latest.entryIndex),
  }
}

export function portableCodexHandoffAfterLine(
  conversation: ConversationDocument,
  baselineLine: number,
): PortableCodexHandoff | null {
  for (let index = conversation.entries.length - 1; index >= 0; index -= 1) {
    const completion = conversation.entries[index]
    if (!completion || completion.source.line <= baselineLine) break
    if (!isCodexTurnCompletion(completion.source.raw)) continue

    const summary = codexCompletionSummary(completion.source.raw)
    if (!summary) continue
    for (let messageIndex = index - 1; messageIndex >= 0; messageIndex -= 1) {
      const candidate = conversation.entries[messageIndex]
      if (!candidate || candidate.source.line <= baselineLine) break
      if (candidate.kind !== 'message' || candidate.role !== 'assistant') continue
      return {
        summary,
        message: candidate,
        completionLine: completion.source.line,
      }
    }
  }
  return null
}

/**
 * Accept an OpenCode portable handoff only after its assistant message is
 * durably complete in the native export.
 *
 * WHY this cannot reuse the Codex completion detector: Codex persists a
 * separate `task_complete` event carrying the final text, while OpenCode puts
 * `time.completed` on the assistant message itself. Looking only for a new
 * assistant entry would race a mid-stream export and project a partial summary.
 */
export function portableOpencodeHandoffAfterLine(
  conversation: ConversationDocument,
  baselineLine: number,
): PortableCodexHandoff | null {
  for (let index = conversation.entries.length - 1; index >= 0; index -= 1) {
    const entry = conversation.entries[index]
    if (!entry || entry.source.line <= baselineLine) break
    if (entry.kind !== 'message' || entry.role !== 'assistant') continue
    const info = isRecord(entry.source.raw.info) ? entry.source.raw.info : null
    const time = info && isRecord(info.time) ? info.time : null
    if (!time || typeof time.completed !== 'number' || !Number.isFinite(time.completed)) continue
    const summary = entry.content
      .filter((content): content is Extract<typeof content, { kind: 'text' }> => (
        content.kind === 'text'
      ))
      .map(content => content.text)
      .join('\n')
      .trim()
    if (!summary) continue
    return { summary, message: entry, completionLine: entry.source.line }
  }
  return null
}

// WHY this is exported: the shrink ladder (operations/shrink.ts) decides which
// compaction entries a foreign target can read, and it must ask the same
// question `describeLatestCompaction` and
// `conversationAfterLatestPortableCompaction` ask. A second copy of the rule in
// the ladder would drift the moment a fifth availability value appeared.
export function compactionAvailability(entry: ConversationCompaction): CompactionAvailability {
  if (entry.summarySource === 'encrypted') return 'native-only'

  // WHY this is checked before the placeholder rule and before the non-empty
  // rule: a rate-limit message is long, non-empty plaintext, so every later
  // branch would classify it as a perfectly good `portable` summary. It is
  // rejected rather than reported `incomplete` because the two mean different
  // things to a host: `incomplete` says "the provider's summary is not fully
  // materialised here, look at the native side", while `rejected` says "this
  // carrier is not a summary at all, never project it" (#820).
  //
  // WHY it is gated on the Claude provider: CLAUDE_RATE_LIMIT_PREFIXES is
  // Claude Code's own list, and the line-start match is wide enough that an
  // unrelated Codex or OpenCode plaintext summary opening a line with "You've
  // used" would otherwise be thrown away for words no other provider ever
  // writes as a limit notice.
  if (entry.source.provider === 'claude' && isRateLimitText(entry.summary)) return 'rejected'

  if (
    entry.summarySource === 'boundary' &&
    entry.summary.trim().toLocaleLowerCase() === CLAUDE_COMPACTION_PLACEHOLDER.toLocaleLowerCase()
  ) {
    return 'incomplete'
  }
  if (entry.summary.trim().length > 0) return 'portable'

  // Legacy ConversationDocument producers predate summarySource. A Codex
  // compacted record is nevertheless a durable native boundary even when its
  // provider-authenticated plaintext is unavailable to the neutral decoder.
  if (entry.source.provider === 'codex' && entry.source.raw.type === 'compacted') {
    return 'native-only'
  }
  return 'incomplete'
}

function isCodexTurnCompletion(raw: Record<string, unknown>): boolean {
  if (raw.type !== 'event_msg' || !isRecord(raw.payload)) return false
  return raw.payload.type === 'task_complete' || raw.payload.type === 'turn_complete'
}

function codexCompletionSummary(raw: Record<string, unknown>): string | null {
  if (!isRecord(raw.payload)) return null
  const value = raw.payload.last_agent_message
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

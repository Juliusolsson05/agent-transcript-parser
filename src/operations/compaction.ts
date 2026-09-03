import type {
  ConversationCompaction,
  ConversationDocument,
  ConversationMessage,
  ProviderId,
} from '../conversation/types.js'

export const CLAUDE_COMPACTION_PLACEHOLDER = 'Conversation compacted'

export type CompactionAvailability = 'portable' | 'native-only' | 'incomplete'

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

function compactionAvailability(entry: ConversationCompaction): CompactionAvailability {
  if (entry.summarySource === 'encrypted') return 'native-only'
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

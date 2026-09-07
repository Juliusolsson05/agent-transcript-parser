import type { ConversationDocument, ConversationEntry } from '../conversation/types.js'

// WHY this module exists separately from contextBudget.ts: the shrink ladder
// (operations/shrink.ts) and the planner (operations/contextBudget.ts) must
// agree, character for character, on what a conversation "costs" and on where a
// turn may legally be cut. Two copies of that arithmetic would drift the moment
// one of them learned about a new entry kind, and the ladder would then report
// a conversation as fitting a budget the planner still considers over. Keeping
// both callers on one estimator is the invariant; the file is deliberately tiny
// and imports nothing but the neutral types so neither consumer can pull the
// other in.
//
// The functions were moved here unchanged from contextBudget.ts.
// `estimateConversationCharacters` is re-exported from that module so the
// published package surface does not move.

/**
 * Cost of one neutral entry in the character budget the planner compares
 * against a target model's window.
 *
 * WHY source.raw is excluded: it duplicates the provider wire record and can be
 * orders of magnitude larger than the semantic content the target model
 * actually receives. The budget must approximate projected prompt payload, not
 * parser provenance retained only for evidence and reporting.
 *
 * WHY tool-call inputs are serialized rather than read as text: a neutral
 * `tool-call.input` is `unknown` on purpose. Claude persists an object
 * (`Write` carries `{ file_path, content }`), while a modern Codex
 * `custom_tool_call` keeps a raw string in `payload.input`. `printableLength`
 * handles both, and the shrink ladder's input-trimming rung branches on the
 * same two shapes so its arithmetic and this estimate never disagree.
 */
export function estimateEntryCharacters(entry: ConversationEntry): number {
  if (entry.kind === 'message') return printableLength({ role: entry.role, content: entry.content })
  if (entry.kind === 'reasoning') return entry.text.length
  if (entry.kind === 'tool-call') return printableLength({ name: entry.name, input: entry.input })
  if (entry.kind === 'tool-result') return printableLength(entry.output)
  if (entry.kind === 'compaction') return entry.summary.length
  return 0
}

export function estimateConversationCharacters(
  conversation: ConversationDocument,
): number {
  return conversation.entries.reduce(
    (total, entry) => total + estimateEntryCharacters(entry),
    0,
  )
}

export function printableLength(value: unknown): number {
  try {
    return (JSON.stringify(value) ?? String(value)).length
  } catch {
    return String(value).length
  }
}

/**
 * WHY only user messages and compaction entries are boundaries: a resumed
 * transcript that begins mid-turn asks the target model to continue an
 * assistant message it never wrote, or to answer a `tool-result` whose
 * `tool-call` no longer exists. Both providers reject or mis-render that.
 * A user message and a compaction summary are the only two entry kinds that
 * legitimately open a conversation.
 */
export function isSafeResumeBoundary(entry: ConversationEntry): boolean {
  return entry.kind === 'compaction' || (
    entry.kind === 'message' && entry.role === 'user'
  )
}

export function nextSafeBoundary(entries: readonly ConversationEntry[], from: number): number {
  for (let index = from; index < entries.length; index += 1) {
    const entry = entries[index]
    if (entry && isSafeResumeBoundary(entry)) return index
  }
  return entries.length
}

export function lastSafeBoundary(entries: readonly ConversationEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry && isSafeResumeBoundary(entry)) return index
  }
  return 0
}

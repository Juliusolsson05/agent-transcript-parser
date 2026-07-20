import type { ConversationEntry } from '../conversation/types.js'

export interface ConversationToolPairing {
  pairedEntryIndexes: Set<number>
  unmatchedEntryIndexes: Set<number>
}

/**
 * Native providers reject or rewrite orphan tool plumbing, so resume output
 * must not contain half a call cycle. Pairing lives in neutral infrastructure
 * because call_id semantics are shared; each provider projector still owns how
 * an unmatched entry is reported and omitted from its wire format.
 */
export function pairConversationTools(
  entries: readonly ConversationEntry[],
): ConversationToolPairing {
  const pendingCalls = new Map<string, number[]>()
  const pairedEntryIndexes = new Set<number>()
  const toolEntryIndexes = new Set<number>()

  for (const [index, entry] of entries.entries()) {
    if (entry.kind === 'tool-call') {
      toolEntryIndexes.add(index)
      const pending = pendingCalls.get(entry.callId) ?? []
      pending.push(index)
      pendingCalls.set(entry.callId, pending)
      continue
    }
    if (entry.kind !== 'tool-result') continue
    toolEntryIndexes.add(index)
    const pending = pendingCalls.get(entry.callId)
    const callIndex = pending?.shift()
    if (callIndex === undefined) continue
    pairedEntryIndexes.add(callIndex)
    pairedEntryIndexes.add(index)
  }

  return {
    pairedEntryIndexes,
    unmatchedEntryIndexes: new Set(
      [...toolEntryIndexes].filter(index => !pairedEntryIndexes.has(index)),
    ),
  }
}

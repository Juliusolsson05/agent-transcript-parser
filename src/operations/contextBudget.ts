import type {
  ConversationDocument,
  ConversationEntry,
} from '../conversation/types.js'

export interface ContextBudgetResult {
  conversation: ConversationDocument
  truncated: boolean
  droppedEntries: number
  estimatedCharactersBefore: number
  estimatedCharactersAfter: number
  budgetCharacters: number
}

export interface ContextBudgetAssessment {
  conversation: ConversationDocument
  estimatedCharacters: number
  budgetCharacters: number
  requiresCompaction: boolean
  usesExistingCompaction: boolean
}

export function assessConversationContextBudget(
  conversation: ConversationDocument,
  budgetCharacters: number,
): ContextBudgetAssessment {
  if (!Number.isSafeInteger(budgetCharacters) || budgetCharacters <= 0) {
    throw new Error('assessConversationContextBudget requires a positive integer budget.')
  }

  const effective = conversationAfterLatestCompaction(conversation)
  const estimatedCharacters = estimateConversationCharacters(effective)
  return {
    conversation: effective,
    estimatedCharacters,
    budgetCharacters,
    requiresCompaction: estimatedCharacters > budgetCharacters,
    usesExistingCompaction: effective !== conversation,
  }
}

export function conversationAfterLatestCompaction(
  conversation: ConversationDocument,
): ConversationDocument {
  let latestCompactionIndex = -1
  for (let index = conversation.entries.length - 1; index >= 0; index -= 1) {
    const entry = conversation.entries[index]
    if (entry?.kind === 'compaction' && entry.summary.trim().length > 0) {
      latestCompactionIndex = index
      break
    }
  }
  if (latestCompactionIndex < 0) return conversation

  // WHY the latest native summary is the semantic replacement for everything
  // before it: retaining the pre-compaction turns in a cross-provider resume
  // makes the target rebuild context the source provider deliberately evicted.
  // Starting at the summary preserves the provider-authored memory while also
  // making the capacity estimate match what a native resume will actually send.
  return {
    ...conversation,
    entries: conversation.entries.slice(latestCompactionIndex),
  }
}

export function estimateConversationCharacters(
  conversation: ConversationDocument,
): number {
  return conversation.entries.reduce(
    (total, entry) => total + estimateEntryCharacters(entry),
    0,
  )
}

export function fitConversationToCharacterBudget(
  conversation: ConversationDocument,
  budgetCharacters: number,
): ContextBudgetResult {
  if (!Number.isSafeInteger(budgetCharacters) || budgetCharacters <= 0) {
    throw new Error('fitConversationToCharacterBudget requires a positive integer budget.')
  }
  const costs = conversation.entries.map(estimateEntryCharacters)
  const estimatedCharactersBefore = estimateConversationCharacters(conversation)
  if (estimatedCharactersBefore <= budgetCharacters) {
    return {
      conversation,
      truncated: false,
      droppedEntries: 0,
      estimatedCharactersBefore,
      estimatedCharactersAfter: estimatedCharactersBefore,
      budgetCharacters,
    }
  }

  let suffixCharacters = 0
  let startIndex = conversation.entries.length
  for (let index = conversation.entries.length - 1; index >= 0; index -= 1) {
    suffixCharacters += costs[index] ?? 0
    const entry = conversation.entries[index]
    if (!entry || !isSafeResumeBoundary(entry)) continue
    startIndex = index
    if (suffixCharacters <= budgetCharacters) continue
    // We crossed the budget while walking backward. The previously observed
    // boundary is the largest complete suffix that fits; this over-budget
    // boundary must stay excluded rather than splitting a user turn in half.
    startIndex = nextSafeBoundary(conversation.entries, index + 1)
    break
  }
  if (startIndex >= conversation.entries.length) {
    // A single final turn may exceed the budget by itself. Keeping that whole
    // turn is still safer than manufacturing an assistant/tool fragment that
    // neither provider can reconstruct. The caller can detect the remaining
    // over-budget estimate and choose a stricter content-level policy later.
    startIndex = lastSafeBoundary(conversation.entries)
  }
  if (startIndex <= 0) {
    return {
      conversation,
      truncated: false,
      droppedEntries: 0,
      estimatedCharactersBefore,
      estimatedCharactersAfter: estimatedCharactersBefore,
      budgetCharacters,
    }
  }

  const dropped = conversation.entries.slice(0, startIndex)
  const kept = conversation.entries.slice(startIndex)
  const previousSummary = [...dropped]
    .reverse()
    .find((entry): entry is Extract<ConversationEntry, { kind: 'compaction' }> => (
      entry.kind === 'compaction' && entry.summary.trim().length > 0
    ))
  const summary = [
    previousSummary?.summary,
    `[Transcript context fit omitted ${dropped.length} earlier entries so the translated session fits the target model. The retained history begins at the next complete user boundary.]`,
  ].filter(Boolean).join('\n\n')
  const source = dropped.at(-1)?.source ?? kept[0]!.source
  const boundary: Extract<ConversationEntry, { kind: 'compaction' }> = {
    kind: 'compaction',
    summary,
    timestamp: kept[0]?.timestamp ?? dropped.at(-1)?.timestamp ?? null,
    source,
  }
  const entries = [boundary, ...kept]
  return {
    conversation: { ...conversation, entries },
    truncated: true,
    droppedEntries: dropped.length,
    estimatedCharactersBefore,
    estimatedCharactersAfter: entries.reduce(
      (total, entry) => total + estimateEntryCharacters(entry),
      0,
    ),
    budgetCharacters,
  }
}

function isSafeResumeBoundary(entry: ConversationEntry): boolean {
  return entry.kind === 'compaction' || (
    entry.kind === 'message' && entry.role === 'user'
  )
}

function nextSafeBoundary(entries: readonly ConversationEntry[], from: number): number {
  for (let index = from; index < entries.length; index += 1) {
    const entry = entries[index]
    if (entry && isSafeResumeBoundary(entry)) return index
  }
  return entries.length
}

function lastSafeBoundary(entries: readonly ConversationEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry && isSafeResumeBoundary(entry)) return index
  }
  return 0
}

function estimateEntryCharacters(entry: ConversationEntry): number {
  // WHY source.raw is excluded: it duplicates the provider wire record and can
  // be orders of magnitude larger than the semantic content the target model
  // actually receives. The budget must approximate projected prompt payload,
  // not parser provenance retained only for evidence and reporting.
  if (entry.kind === 'message') return printableLength({ role: entry.role, content: entry.content })
  if (entry.kind === 'reasoning') return entry.text.length
  if (entry.kind === 'tool-call') return printableLength({ name: entry.name, input: entry.input })
  if (entry.kind === 'tool-result') return printableLength(entry.output)
  if (entry.kind === 'compaction') return entry.summary.length
  return 0
}

function printableLength(value: unknown): number {
  try {
    return (JSON.stringify(value) ?? String(value)).length
  } catch {
    return String(value).length
  }
}

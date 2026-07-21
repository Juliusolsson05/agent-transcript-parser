import type {
  ConversationDocument,
  ConversationEntry,
  ProviderId,
} from '../conversation/types.js'
import {
  compactionPortability,
  conversationAfterLatestPortableCompaction,
  describeLatestCompaction,
} from './compaction.js'

export const DEFAULT_CHARACTERS_PER_TOKEN = 2.5
export const DEFAULT_CONTEXT_RESERVE_FRACTION = 0.1

export interface ContextBudgetResult {
  conversation: ConversationDocument
  truncated: boolean
  droppedEntries: number
  estimatedCharactersBefore: number
  estimatedCharactersAfter: number
  budgetCharacters: number
  stillExceedsBudget: boolean
}

export interface ContextBudgetAssessment {
  conversation: ConversationDocument
  estimatedCharacters: number
  budgetCharacters: number
  requiresCompaction: boolean
  usesExistingCompaction: boolean
}

export type ConversationContextPlan =
  | {
      kind: 'ready'
      conversation: ConversationDocument
      estimatedCharacters: number
      budgetCharacters: number
    }
  | {
      kind: 'existing-compaction'
      conversation: ConversationDocument
      estimatedCharacters: number
      budgetCharacters: number
      compactionSourceLine: number
    }
  | {
      kind: 'requires-portable-handoff'
      conversation: ConversationDocument
      estimatedCharacters: number
      budgetCharacters: number
      compactionSourceLine: number
    }
  | {
      kind: 'requires-compaction'
      conversation: ConversationDocument
      estimatedCharacters: number
      budgetCharacters: number
      overflowCharacters: number
    }

export interface ContextCharacterBudgetOptions {
  effectiveContextPercent?: number
  reserveFraction?: number
  charactersPerToken?: number
}

export function budgetCharactersForContextTokens(
  contextTokens: number,
  options: ContextCharacterBudgetOptions = {},
): number {
  if (!Number.isFinite(contextTokens) || contextTokens <= 0) {
    throw new Error('budgetCharactersForContextTokens requires a positive context token count.')
  }
  const effectiveContextPercent = options.effectiveContextPercent ?? 100
  const reserveFraction = options.reserveFraction ?? DEFAULT_CONTEXT_RESERVE_FRACTION
  const charactersPerToken = options.charactersPerToken ?? DEFAULT_CHARACTERS_PER_TOKEN
  if (effectiveContextPercent <= 0 || effectiveContextPercent > 100) {
    throw new Error('effectiveContextPercent must be greater than zero and at most 100.')
  }
  if (reserveFraction < 0 || reserveFraction >= 1) {
    throw new Error('reserveFraction must be at least zero and less than one.')
  }
  if (!Number.isFinite(charactersPerToken) || charactersPerToken <= 0) {
    throw new Error('charactersPerToken must be positive.')
  }
  return Math.floor(
    contextTokens * (effectiveContextPercent / 100) * (1 - reserveFraction) * charactersPerToken,
  )
}

export function planConversationContext(
  conversation: ConversationDocument,
  targetProvider: ProviderId,
  budgetCharacters: number,
): ConversationContextPlan {
  assertCharacterBudget(budgetCharacters, 'planConversationContext')
  const latest = describeLatestCompaction(conversation)
  const portability = compactionPortability(conversation.sourceProvider, targetProvider)

  // WHY native-only compaction is checked before raw size: pre-compaction
  // records may still be present on disk, but Codex no longer sends them to its
  // model. A cross-provider target needs Codex to decrypt and summarize its own
  // replacement history even if those stale records happen to fit numerically.
  if (
    latest?.availability === 'native-only' &&
    portability.requiresPlaintextHandoffTurn
  ) {
    return {
      kind: 'requires-portable-handoff',
      conversation,
      estimatedCharacters: estimateConversationCharacters(conversation),
      budgetCharacters,
      compactionSourceLine: latest.entry.source.line,
    }
  }

  const effective = conversationAfterLatestPortableCompaction(conversation)
  const estimatedCharacters = estimateConversationCharacters(effective)
  if (estimatedCharacters <= budgetCharacters) {
    return effective === conversation
      ? { kind: 'ready', conversation, estimatedCharacters, budgetCharacters }
      : {
          kind: 'existing-compaction',
          conversation: effective,
          estimatedCharacters,
          budgetCharacters,
          compactionSourceLine: latest!.entry.source.line,
        }
  }

  return {
    kind: 'requires-compaction',
    conversation: effective,
    estimatedCharacters,
    budgetCharacters,
    overflowCharacters: estimatedCharacters - budgetCharacters,
  }
}

export function assessConversationContextBudget(
  conversation: ConversationDocument,
  budgetCharacters: number,
): ContextBudgetAssessment {
  assertCharacterBudget(budgetCharacters, 'assessConversationContextBudget')

  const effective = conversationAfterLatestPortableCompaction(conversation)
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
  return conversationAfterLatestPortableCompaction(conversation)
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
  assertCharacterBudget(budgetCharacters, 'fitConversationToCharacterBudget')
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
      stillExceedsBudget: false,
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
      stillExceedsBudget: true,
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
    summarySource: 'synthetic',
    timestamp: kept[0]?.timestamp ?? dropped.at(-1)?.timestamp ?? null,
    source,
  }
  const entries = [boundary, ...kept]
  const estimatedCharactersAfter = entries.reduce(
    (total, entry) => total + estimateEntryCharacters(entry),
    0,
  )
  return {
    conversation: { ...conversation, entries },
    truncated: true,
    droppedEntries: dropped.length,
    estimatedCharactersBefore,
    estimatedCharactersAfter,
    budgetCharacters,
    stillExceedsBudget: estimatedCharactersAfter > budgetCharacters,
  }
}

function assertCharacterBudget(budgetCharacters: number, caller: string): void {
  if (!Number.isSafeInteger(budgetCharacters) || budgetCharacters <= 0) {
    throw new Error(`${caller} requires a positive integer budget.`)
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

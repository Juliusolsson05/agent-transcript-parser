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
import {
  estimateConversationCharacters,
  estimateEntryCharacters,
  isSafeResumeBoundary,
  lastSafeBoundary,
  nextSafeBoundary,
} from './estimate.js'
import { shrinkConversationToBudget, stripNativeOnlyCompactions } from './shrink.js'
import type { ShrinkOptions, ShrinkReport } from './shrink.js'

// WHY the estimator is re-exported rather than moved outright: it has been part
// of this module's published surface since the first context-budget release and
// every host imports it from the package root. The implementation now lives in
// operations/estimate.ts so the shrink ladder can share it without importing
// the planner (which would make the dependency circular).
export { estimateConversationCharacters } from './estimate.js'

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
  /**
   * The source's own compaction carried nothing the target can read, but the
   * records it summarized are still on disk and they fit. Only reachable with
   * `allowSourceTurns: false`.
   */
  | {
      kind: 'raw-history'
      conversation: ConversationDocument
      estimatedCharacters: number
      budgetCharacters: number
      strippedCompactions: number
    }
  /**
   * The deterministic ladder had to remove content. `report` is the complete
   * account of what it cost, because design principle 3 is that no lossy step
   * is silent. Only reachable with `allowSourceTurns: false`.
   */
  | {
      kind: 'shrunk'
      conversation: ConversationDocument
      estimatedCharacters: number
      budgetCharacters: number
      report: ShrinkReport
    }

export interface PlanConversationContextOptions {
  /**
   * WHY this defaults to true: every existing caller relies on the four
   * original outcomes, two of which instruct the host to run a live turn on the
   * source (`requires-portable-handoff` and `requires-compaction`). Flipping
   * the default would silently change what those callers do at the exact moment
   * a provider switch is under way. A host that cannot or will not spend source
   * quota passes false and receives only outcomes it can execute alone.
   */
  allowSourceTurns?: boolean
  shrink?: ShrinkOptions
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
  options: PlanConversationContextOptions = {},
): ConversationContextPlan {
  assertCharacterBudget(budgetCharacters, 'planConversationContext')
  // WHY this is the first statement and not a branch woven into the logic
  // below: the two paths answer different questions. The default path asks
  // "what must the source do before this conversation can move?"; this one asks
  // "what can be moved without the source at all?". Interleaving them would
  // make every later condition carry an `allowSourceTurns` clause, and the one
  // that got forgotten would spend quota the caller said it does not have.
  if (options.allowSourceTurns === false) {
    return planWithoutSourceTurns(conversation, budgetCharacters, options.shrink)
  }
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

/**
 * The `allowSourceTurns: false` planner.
 *
 * Ordering matters and is the whole design:
 *
 * 1. **Slice at the latest portable compaction first.** A plaintext summary the
 *    source wrote has already replaced everything before it — native resume no
 *    longer sends those turns to the model. Stripping before slicing could
 *    resurrect records the source itself evicted, and the target would then see
 *    both the summary and the history it summarizes.
 * 2. **Then strip what the target cannot read.** An encrypted Codex carrier, an
 *    `incomplete` boundary placeholder and a `rejected` rate-limit carrier all
 *    convey nothing across providers, while the records they claim to summarize
 *    are still present. Removing them is what turns the old
 *    `requires-portable-handoff` outcome — which cost a live source turn — into
 *    `raw-history`, which costs nothing. Census finding 6 says this is the
 *    common case, not the exotic one: 211 of 230 single-compaction rollouts
 *    (91.7 %) keep a median 74.3 % of their characters ahead of the compaction.
 * 3. **Only then shrink.** The ladder is the last resort and reports what it
 *    cost.
 */
function planWithoutSourceTurns(
  conversation: ConversationDocument,
  budgetCharacters: number,
  shrink: ShrinkOptions | undefined,
): ConversationContextPlan {
  const latest = describeLatestCompaction(conversation)
  const sliced = conversationAfterLatestPortableCompaction(conversation)
  const stripped = stripNativeOnlyCompactions(sliced)
  const estimatedCharacters = estimateConversationCharacters(stripped.conversation)

  if (estimatedCharacters <= budgetCharacters) {
    if (stripped.stripped > 0) {
      return {
        kind: 'raw-history',
        conversation: stripped.conversation,
        estimatedCharacters,
        budgetCharacters,
        strippedCompactions: stripped.stripped,
      }
    }
    // Nothing was stripped, so this is one of the two pre-existing outcomes and
    // must stay reported as such: hosts label the strategy from the plan kind,
    // and a switch that lost nothing should not read as one that did.
    return sliced === conversation || latest === null
      ? { kind: 'ready', conversation, estimatedCharacters, budgetCharacters }
      : {
          kind: 'existing-compaction',
          conversation: sliced,
          estimatedCharacters,
          budgetCharacters,
          compactionSourceLine: latest.entry.source.line,
        }
  }

  // Throws ConversationUnfittableError when even one complete turn is too
  // large. That propagates deliberately: there is no fifth outcome that could
  // honestly describe "we emitted half a turn".
  const { conversation: shrunk, report } = shrinkConversationToBudget(
    stripped.conversation,
    budgetCharacters,
    shrink,
  )
  return {
    kind: 'shrunk',
    conversation: shrunk,
    estimatedCharacters: report.estimatedCharactersAfter,
    budgetCharacters,
    report,
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

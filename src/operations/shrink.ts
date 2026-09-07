import type {
  ConversationCompaction,
  ConversationDocument,
  ConversationEntry,
  ConversationMessage,
  ConversationToolCall,
  ConversationToolResult,
} from '../conversation/types.js'
import { compactionAvailability } from './compaction.js'
import {
  estimateConversationCharacters,
  estimateEntryCharacters,
  isSafeResumeBoundary,
  printableLength,
} from './estimate.js'

// See docs/superpowers/specs/2026-09-05-quota-independent-provider-switch-design.md
// §"Shrink ladder". This module is the isolated hard part of quota-independent
// switching: it is the ONLY place that decides what a transcript loses when it
// must fit a smaller window without any model call. It knows entry kinds and
// character budgets. It never names a provider. Its only consumer is
// planConversationContext; projectors and hosts must not import it.
//
// The ladder is ordered by what the loss costs the target model, cheapest
// first, and every rung stops the moment the estimate fits — so a conversation
// that is 5 % over budget loses a few old tool outputs, not a third of its
// history. Each rung reports what it did, because principle 3 of the design is
// that no lossy step is silent.

export interface ShrinkOptions {
  keepRecentTurns?: number
  maxInputChars?: number
  maxIndexedPrompts?: number
  promptIndexChars?: number
}

export interface ShrinkReport {
  strippedCompactions: number
  clearedResults: number
  clearedChars: number
  trimmedInputs: number
  trimmedChars: number
  droppedEntries: number
  droppedTurns: number
  promptIndexChars: number
  estimatedCharactersBefore: number
  estimatedCharactersAfter: number
  budgetCharacters: number
}

export interface ShrinkResult {
  conversation: ConversationDocument
  report: ShrinkReport
}

/**
 * Thrown when no rung of the ladder can make the conversation fit.
 *
 * WHY an error and not a best-effort fragment: the last rung stops at a
 * complete user turn on purpose. A transcript that begins mid-turn asks the
 * target to continue an assistant message it never wrote, or answers a
 * `tool_result` whose `tool_use` is gone — Claude rejects the whole resumed
 * conversation for the second case. A host that receives this error can still
 * offer the user a source-side compaction, start a fresh session, or pick a
 * larger target; a host that receives a fragment cannot tell that anything
 * went wrong until the target refuses the session.
 */
export class ConversationUnfittableError extends Error {
  readonly report: ShrinkReport

  constructor(report: ShrinkReport) {
    super(
      `Conversation cannot fit the target budget of ${report.budgetCharacters} characters: ` +
      `the smallest complete suffix the ladder can produce is ${report.estimatedCharactersAfter} characters.`,
    )
    this.name = 'ConversationUnfittableError'
    this.report = report
  }
}

/**
 * Defaults, and what the Stage 0 census
 * (docs/decomposition/evidence/provider-switch/census.md) actually measured
 * behind each of them.
 *
 * What the census DID measure, over 3,328 local transcripts and 7.15 GB with no
 * sampling:
 *
 * - Tool results are where the bytes are. Their share of planner characters has
 *   a median of **71.8 %** across the 91 local Claude transcripts over the
 *   581,400-character Codex budget (quartiles 49.2–85.0 %, floor 23.3 %).
 *   Nothing else is close, in any fixture or in the population. That is why
 *   clearing them is rung 2 and why it is unconditional.
 * - Clearing is necessary but not sufficient. With **every** tool-result output
 *   cleared, **46 of those 91 (50.5 %)** are still over budget — median 1.04×,
 *   p90 3.81×, worst 12.41×. The drop rung is therefore a primary mechanism
 *   that fires about half the time in production, not a theoretical last
 *   resort.
 * - Reasoning is worth nothing to strip: it contributes **zero** characters in
 *   all four measured fixtures. Codex reasoning is encrypted, and 5,471 of
 *   5,639 sampled Claude thinking blocks (97.0 %) persist an empty `thinking`
 *   string beside their signature. There is no rung for it because there is
 *   nothing to reclaim.
 * - A Codex compaction summary is worth zero characters and carries no portable
 *   text (all five compaction entries across the two Codex fixtures decode
 *   empty, `summarySource: 'encrypted'`). Budget arithmetic must never credit
 *   one with having "already shrunk" anything — which is exactly what rung 1
 *   encodes.
 *
 * What the census did NOT measure, and therefore what these two numbers are:
 *
 * - `maxInputChars` and `keepRecentTurns` are **placeholders**. The census
 *   reports no per-turn size distribution and no tool-call input-size
 *   percentiles; it reports only that tool-call inputs are 27.7 % of the
 *   hardest fixture's characters. 8,000 characters is "about a 200-line file
 *   write" and three turns is "what I was just doing", both chosen by
 *   argument rather than by measurement. The live probe (Stage 7 of the
 *   decomposition) is what will replace them with observed numbers; until it
 *   reports, treat both as unvalidated.
 * - `maxIndexedPrompts` and `promptIndexChars` bound a courtesy list, not a
 *   loss: 40 × 200 characters is 8,208 characters worst case, 1.4 % of a real
 *   581,400-character budget. They exist so the index cannot itself become the
 *   thing that overflows the window.
 */
const DEFAULTS: Required<ShrinkOptions> = {
  keepRecentTurns: 3,
  maxInputChars: 8_000,
  maxIndexedPrompts: 40,
  promptIndexChars: 200,
}

/**
 * Rung 1. Remove every compaction entry the target cannot read.
 *
 * WHY the test is "keep only `portable`" rather than "drop `native-only`":
 * Task 1 gave `compactionAvailability` a fourth value. A Claude carrier whose
 * text contains one of Claude Code's rate-limit lines now returns `rejected`
 * (#820) — it is not a summary at all, it is the product's "you've hit your
 * monthly spend limit" message that landed where a summary belongs, and
 * `conversationAfterLatestPortableCompaction` already refuses to slice at it.
 * Keeping only `portable` therefore strips encrypted Codex carriers,
 * `incomplete` boundary placeholders AND rejected limit messages in one rule.
 * That is deliberate: all four cases mean "this entry carries no history a
 * foreign target can use", and in all four the records the entry claims to
 * summarize are still present in the conversation. A branch per value would
 * only create a second place to forget the next one.
 *
 * Portable and synthetic summaries stay. They are real, readable content —
 * a synthetic marker is this module's own output, and re-running the ladder
 * must not silently delete the explanation of an earlier drop.
 */
export function stripNativeOnlyCompactions(
  conversation: ConversationDocument,
): { conversation: ConversationDocument; stripped: number } {
  const entries = conversation.entries.filter(entry => (
    entry.kind !== 'compaction' || compactionAvailability(entry) === 'portable'
  ))
  return {
    conversation: entries.length === conversation.entries.length
      ? conversation
      : { ...conversation, entries },
    stripped: conversation.entries.length - entries.length,
  }
}

/**
 * Rung 2. Replace old tool outputs with a bounded placeholder, oldest first.
 *
 * The entry, its `callId` and its `isError` flag survive, so the call/result
 * pairing every projector relies on is untouched; only the payload goes. Tool
 * *inputs* are never touched here — edit diffs live there, and losing them
 * would mean the target cannot see what the session changed.
 */
export function clearToolResults(
  conversation: ConversationDocument,
  budgetCharacters: number,
  options: ShrinkOptions = {},
): { conversation: ConversationDocument; cleared: number; clearedChars: number } {
  const keepRecentTurns = options.keepRecentTurns ?? DEFAULTS.keepRecentTurns
  const limit = protectedFromIndex(conversation.entries, keepRecentTurns)
  let total = estimateConversationCharacters(conversation)
  if (total <= budgetCharacters) return { conversation, cleared: 0, clearedChars: 0 }

  const entries = [...conversation.entries]
  let cleared = 0
  let clearedChars = 0
  for (let index = 0; index < limit && total > budgetCharacters; index += 1) {
    const entry = entries[index]!
    if (entry.kind !== 'tool-result') continue
    const before = estimateEntryCharacters(entry)
    const replaced: ConversationToolResult = { ...entry, output: clearedPlaceholder(before) }
    const after = estimateEntryCharacters(replaced)
    // WHY a net-savings guard rather than clearing unconditionally: the
    // placeholder is itself ~58 characters, so clearing a short output would
    // make the conversation LARGER while the report claimed it shrank. The
    // report is the host's only evidence of what the switch cost the user, so
    // it must never be able to lie. (This is also why the committed, redacted
    // fixtures cannot exercise this rung: redaction leaves every output at 51
    // characters or fewer. See testing/engine/fixtureConversations.ts.)
    if (after >= before) continue
    entries[index] = replaced
    total -= before - after
    cleared += 1
    clearedChars += before - after
  }
  return {
    conversation: cleared === 0 ? conversation : { ...conversation, entries },
    cleared,
    clearedChars,
  }
}

/**
 * Rung 3. Truncate tool-call inputs above `maxInputChars`, oldest first.
 *
 * Only reached when clearing every reachable result was not enough, which the
 * census says happens for about half of real over-budget transcripts.
 */
export function trimToolInputs(
  conversation: ConversationDocument,
  budgetCharacters: number,
  options: ShrinkOptions = {},
): { conversation: ConversationDocument; trimmed: number; trimmedChars: number } {
  const keepRecentTurns = options.keepRecentTurns ?? DEFAULTS.keepRecentTurns
  const maxInputChars = options.maxInputChars ?? DEFAULTS.maxInputChars
  const limit = protectedFromIndex(conversation.entries, keepRecentTurns)
  let total = estimateConversationCharacters(conversation)
  if (total <= budgetCharacters) return { conversation, trimmed: 0, trimmedChars: 0 }

  const entries = [...conversation.entries]
  let trimmed = 0
  let trimmedChars = 0
  for (let index = 0; index < limit && total > budgetCharacters; index += 1) {
    const entry = entries[index]!
    if (entry.kind !== 'tool-call') continue
    const input = trimToolCallInput(entry.input, maxInputChars)
    if (input === null) continue
    const before = estimateEntryCharacters(entry)
    const replaced: ConversationToolCall = { ...entry, input }
    const after = estimateEntryCharacters(replaced)
    if (after >= before) continue
    entries[index] = replaced
    total -= before - after
    trimmed += 1
    trimmedChars += before - after
  }
  return {
    conversation: trimmed === 0 ? conversation : { ...conversation, entries },
    trimmed,
    trimmedChars,
  }
}

/**
 * Rung 4. Drop whole oldest turns and explain the loss in a synthetic marker.
 *
 * Two invariants make this rung safe to ship:
 *
 * 1. **Never cut inside a turn.** The retained history always begins at a safe
 *    resume boundary (a user message or a compaction), so the target never
 *    receives an orphaned tool result or a half-finished assistant reply.
 * 2. **Never drop a developer message.** Census finding 4: Codex developer
 *    messages are 36.9 % of the repeatedly-compacted fixture's characters, and
 *    they are the replacement history and standing user instructions that
 *    survive a remote compaction — on a compacted Codex thread they are the
 *    ONLY plaintext left in the file. A ladder that dropped them would delete
 *    the conversation while reporting that it merely trimmed some turns. They
 *    are therefore retained after the marker, in their original relative order,
 *    and they still count against the budget: if the developer messages alone
 *    exceed it, `stillExceedsBudget` is the honest answer and the caller throws
 *    rather than pretending a lossier cut would have helped.
 */
export function dropOldestTurns(
  conversation: ConversationDocument,
  budgetCharacters: number,
  options: ShrinkOptions = {},
): {
  conversation: ConversationDocument
  droppedEntries: number
  droppedTurns: number
  promptIndexChars: number
  stillExceedsBudget: boolean
} {
  const maxIndexedPrompts = options.maxIndexedPrompts ?? DEFAULTS.maxIndexedPrompts
  const promptIndexChars = options.promptIndexChars ?? DEFAULTS.promptIndexChars
  const entries = conversation.entries
  const costs = entries.map(estimateEntryCharacters)
  const total = costs.reduce((sum, cost) => sum + cost, 0)
  if (total <= budgetCharacters) {
    return {
      conversation,
      droppedEntries: 0,
      droppedTurns: 0,
      promptIndexChars: 0,
      stillExceedsBudget: false,
    }
  }

  // `suffixCost[i]` is what entries[i..] costs; `developerPrefixCost[i]` is
  // what the developer messages BEFORE i cost, because those survive the cut
  // wherever it lands. Retaining at boundary i therefore costs the sum of the
  // two, and that sum is non-increasing in i — a developer message moves from
  // one accumulator to the other as i grows, never appearing in both — so the
  // first boundary that fits, scanning oldest to newest, keeps the most
  // history. Precomputing both makes the search below O(1) per boundary
  // instead of O(n); the largest local transcript in the census has 13,577
  // entries and roughly a thousand boundaries.
  const suffixCost = new Array<number>(entries.length + 1).fill(0)
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    suffixCost[index] = suffixCost[index + 1]! + costs[index]!
  }
  const developerPrefixCost = new Array<number>(entries.length + 1).fill(0)
  for (let index = 0; index < entries.length; index += 1) {
    developerPrefixCost[index + 1] = developerPrefixCost[index]! +
      (isDeveloperMessage(entries[index]!) ? costs[index]! : 0)
  }

  const boundaries: number[] = []
  for (let index = 1; index < entries.length; index += 1) {
    if (isSafeResumeBoundary(entries[index]!)) boundaries.push(index)
  }

  for (const startIndex of boundaries) {
    const retained = suffixCost[startIndex]! + developerPrefixCost[startIndex]!
    if (retained > budgetCharacters) continue
    const cut = assembleCut(
      conversation,
      startIndex,
      budgetCharacters - retained,
      maxIndexedPrompts,
      promptIndexChars,
    )
    // The marker is budget-aware (see assembleCut), but its irreducible
    // headline may still not fit at this boundary. Fall through to the next
    // one rather than emitting a conversation that is over budget by the
    // length of its own apology.
    if (cut.markerChars > budgetCharacters - retained) continue
    return { ...cut.result, stillExceedsBudget: false }
  }

  // Nothing fits. Keep the last complete turn whole and say so; the caller
  // decides whether that is an error. Never manufacture a fragment.
  const lastBoundary = boundaries.at(-1)
  if (lastBoundary === undefined) {
    return {
      conversation,
      droppedEntries: 0,
      droppedTurns: 0,
      promptIndexChars: 0,
      stillExceedsBudget: true,
    }
  }
  const cut = assembleCut(conversation, lastBoundary, 0, maxIndexedPrompts, promptIndexChars)
  return { ...cut.result, stillExceedsBudget: true }
}

/**
 * The ladder itself: rungs in order, each applied only as far as needed.
 */
export function shrinkConversationToBudget(
  conversation: ConversationDocument,
  budgetCharacters: number,
  options: ShrinkOptions = {},
): ShrinkResult {
  if (!Number.isSafeInteger(budgetCharacters) || budgetCharacters <= 0) {
    throw new Error('shrinkConversationToBudget requires a positive integer budget.')
  }
  const report: ShrinkReport = {
    strippedCompactions: 0,
    clearedResults: 0,
    clearedChars: 0,
    trimmedInputs: 0,
    trimmedChars: 0,
    droppedEntries: 0,
    droppedTurns: 0,
    promptIndexChars: 0,
    estimatedCharactersBefore: estimateConversationCharacters(conversation),
    estimatedCharactersAfter: 0,
    budgetCharacters,
  }

  // Rung 1: encrypted, incomplete and rejected compactions carry nothing a
  // foreign target can read; the records they summarized are still here.
  const stripped = stripNativeOnlyCompactions(conversation)
  report.strippedCompactions = stripped.stripped
  let current = stripped.conversation

  // Rung 2: tool outputs are the bulk of coding sessions (median 71.8 % of
  // characters) and the cheapest thing to lose; the model's own words and
  // every edit input survive.
  const cleared = clearToolResults(current, budgetCharacters, options)
  report.clearedResults = cleared.cleared
  report.clearedChars = cleared.clearedChars
  current = cleared.conversation

  // Rung 3: oversized inputs (whole-file writes) beyond a cap.
  const trimmed = trimToolInputs(current, budgetCharacters, options)
  report.trimmedInputs = trimmed.trimmed
  report.trimmedChars = trimmed.trimmedChars
  current = trimmed.conversation

  // Rung 4: drop whole oldest turns, indexing their prompts in the marker.
  const dropped = dropOldestTurns(current, budgetCharacters, options)
  report.droppedEntries = dropped.droppedEntries
  report.droppedTurns = dropped.droppedTurns
  report.promptIndexChars = dropped.promptIndexChars
  current = dropped.conversation

  report.estimatedCharactersAfter = estimateConversationCharacters(current)
  if (dropped.stillExceedsBudget || report.estimatedCharactersAfter > budgetCharacters) {
    throw new ConversationUnfittableError(report)
  }
  return { conversation: current, report }
}

function clearedPlaceholder(chars: number): string {
  return `[tool output cleared during provider switch: ${chars} characters]`
}

function userTurnStarts(entries: readonly ConversationEntry[]): number[] {
  const starts: number[] = []
  entries.forEach((entry, index) => {
    if (entry.kind === 'message' && entry.role === 'user') starts.push(index)
  })
  return starts
}

/**
 * The index at which the recent-turn protection begins; everything from here on
 * is off limits to rungs 2 and 3.
 *
 * WHY the protection is skipped entirely when the conversation has at most
 * `keepRecentTurns` user turns, rather than protecting all of them: the rule
 * exists to keep "what I was just doing" intact, which is a statement about the
 * boundary between old history and recent work. A conversation with no such
 * boundary would otherwise be 100 % protected and the whole ladder would become
 * a no-op. That is not hypothetical — `claude-sequence-oversized` is a real
 * transcript with 67 entries, exactly ONE user message, 92.1 % of its
 * characters in tool results, and 1.11× the Codex budget. The census counts it
 * among the 45 of 91 oversized transcripts that clearing tool results alone
 * fixes, and that population measurement cleared every result with no
 * recent-turn protection at all. Declaring such a session unfittable while
 * nine tenths of it is stale tool output would be a worse answer than the one
 * the evidence supports.
 *
 * What is kept in the relaxed case is the weaker, still-real guarantee that
 * comes from the walk order: rungs 2 and 3 go oldest first and stop the instant
 * the estimate fits, so the newest outputs are always the last to go.
 */
function protectedFromIndex(
  entries: readonly ConversationEntry[],
  keepRecentTurns: number,
): number {
  const starts = userTurnStarts(entries)
  if (keepRecentTurns <= 0 || starts.length <= keepRecentTurns) return entries.length
  return starts[starts.length - keepRecentTurns] ?? entries.length
}

/**
 * Truncate one tool-call input, preserving the shape the target expects.
 *
 * Returns `null` when there is nothing worth trimming.
 *
 * WHY objects are trimmed field-by-field instead of being replaced with a
 * truncated JSON string, which is the obvious one-liner: a Claude historical
 * `tool_use.input` MUST be an object. Replacing `{ file_path, content }` with a
 * string forces the Claude projector into its `input-object-repaired` path,
 * which wraps the value as `{ input: "..." }` — the target then sees a `Write`
 * whose `file_path` has vanished. Growing the largest string member instead
 * keeps every key and every short scalar, so the target can still read which
 * file was written even though it can no longer read all of what was written.
 *
 * A raw string input is handled directly because a modern Codex
 * `custom_tool_call` persists its input as a string in `payload.input`, and the
 * decoded entry keeps it that way; `estimateEntryCharacters` serializes both
 * shapes through the same `printableLength`, so the arithmetic here and the
 * budget arithmetic there cannot disagree.
 */
function trimToolCallInput(input: unknown, maxInputChars: number): unknown | null {
  if (typeof input === 'string') {
    if (input.length <= maxInputChars) return null
    const candidate = truncateWithMarker(input, maxInputChars)
    return candidate.length < input.length ? candidate : null
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
  if (printableLength(input) <= maxInputChars) return null

  const next: Record<string, unknown> = { ...(input as Record<string, unknown>) }
  const stringKeys = Object.keys(next)
    .filter(key => typeof next[key] === 'string')
    .sort((a, b) => (next[b] as string).length - (next[a] as string).length)
  let changed = false
  for (const key of stringKeys) {
    const serialized = printableLength(next)
    if (serialized <= maxInputChars) break
    const value = next[key] as string
    const candidate = truncateWithMarker(value, Math.max(0, value.length - (serialized - maxInputChars)))
    if (candidate.length >= value.length) continue
    next[key] = candidate
    changed = true
  }
  return changed ? next : null
}

function truncateWithMarker(text: string, keep: number): string {
  const omitted = text.length - keep
  return `${text.slice(0, keep)}\n[tool input trimmed during provider switch: ${omitted} characters omitted]`
}

function isDeveloperMessage(entry: ConversationEntry): entry is ConversationMessage {
  return entry.kind === 'message' && entry.role === 'developer'
}

function promptText(entry: ConversationEntry): string {
  if (entry.kind !== 'message') return ''
  return entry.content
    .filter(content => content.kind === 'text')
    .map(content => (content.kind === 'text' ? content.text : ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

interface AssembledCut {
  markerChars: number
  result: {
    conversation: ConversationDocument
    droppedEntries: number
    droppedTurns: number
    promptIndexChars: number
  }
}

/**
 * Build the conversation that results from cutting at `startIndex`.
 *
 * `room` is how many characters the marker may occupy before the result goes
 * over budget. The prompt index is trimmed to fit it, oldest entry first, and
 * a carried-over plaintext summary is dropped before the headline is — because
 * the headline is the only part the target actually needs to understand that
 * history is missing, while the index is a courtesy. Reserving the worst case
 * (40 prompts × 200 characters = 8,208) up front instead would be 1.4 % of a
 * real 581,400-character budget but a third of a small one, and would drop
 * turns nobody asked to lose.
 */
function assembleCut(
  conversation: ConversationDocument,
  startIndex: number,
  room: number,
  maxIndexedPrompts: number,
  promptIndexChars: number,
): AssembledCut {
  const dropped = conversation.entries.slice(0, startIndex)
  const kept = conversation.entries.slice(startIndex)
  const retainedDevelopers = dropped.filter(isDeveloperMessage)
  const removedEntries = dropped.length - retainedDevelopers.length
  const prompts = dropped
    .filter(entry => entry.kind === 'message' && entry.role === 'user')
    .map(promptText)
    .filter(text => text.length > 0)
  const carried = [...dropped].reverse().find(
    (entry): entry is ConversationCompaction => (
      entry.kind === 'compaction' && entry.summary.trim().length > 0
    ),
  )?.summary

  let shown = prompts.slice(-maxIndexedPrompts).map(text => text.slice(0, promptIndexChars))
  let summary = composeMarkerSummary(carried, removedEntries, prompts, shown, retainedDevelopers.length)
  while (summary.text.length > room && shown.length > 0) {
    shown = shown.slice(1)
    summary = composeMarkerSummary(carried, removedEntries, prompts, shown, retainedDevelopers.length)
  }
  if (summary.text.length > room && carried !== undefined) {
    summary = composeMarkerSummary(undefined, removedEntries, prompts, shown, retainedDevelopers.length)
  }

  const marker: ConversationCompaction = {
    kind: 'compaction',
    summary: summary.text,
    summarySource: 'synthetic',
    timestamp: kept[0]?.timestamp ?? dropped.at(-1)?.timestamp ?? null,
    source: dropped.at(-1)?.source ?? kept[0]!.source,
  }
  return {
    markerChars: summary.text.length,
    result: {
      conversation: { ...conversation, entries: [marker, ...retainedDevelopers, ...kept] },
      droppedEntries: removedEntries,
      droppedTurns: prompts.length,
      promptIndexChars: summary.indexChars,
    },
  }
}

function composeMarkerSummary(
  carried: string | undefined,
  removedEntries: number,
  prompts: readonly string[],
  shown: readonly string[],
  retainedDevelopers: number,
): { text: string; indexChars: number } {
  const offset = prompts.length - shown.length
  const index = shown.map((text, position) => `${offset + position + 1}. ${text}`).join('\n')
  const developerNote = retainedDevelopers > 0
    ? ` The ${retainedDevelopers} developer message${retainedDevelopers === 1 ? '' : 's'} that preceded the cut are retained immediately below; on a compacted thread they are the only plaintext history left.`
    : ''
  const indexNote = shown.length === 0
    ? ''
    : ` The earlier prompts, oldest first${prompts.length > shown.length ? ` (last ${shown.length} shown)` : ''}:\n${index}`
  const headline =
    `[Provider switch omitted ${removedEntries} earlier entries across ${prompts.length} user turns ` +
    `so the session fits the target model.${developerNote} ` +
    `The retained history begins at the next complete user turn.${indexNote}]`
  return {
    text: [carried, headline].filter(Boolean).join('\n\n'),
    indexChars: index.length,
  }
}

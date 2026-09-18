import type {
  ConversationCompaction,
  ConversationContent,
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

// Design source of truth: agent-code `docs/design/provider-switching.md`
// §"The shrink ladder" is the living description of this module. The original
// spec, docs/superpowers/specs/2026-09-05-quota-independent-provider-switch-design.md
// §"Shrink ladder", records why the ladder exists but predates rung 3 and the
// second pass and therefore numbers the later rungs differently (its As-built
// item 11 says so). This module is the isolated hard part of quota-independent
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
//
// The rungs run in two passes. The first honours the recent-turn protection:
// the clearing rungs (2–4) leave the newest `keepRecentTurns` user turns alone
// and the drop rung (5) removes whole old turns. Only when the drop rung cannot
// fit ANY complete turn — the protected suffix alone is over budget — does the
// second pass lift the protection, using the cheapest subset of the clearing
// rungs that keeps as much history as lifting all of them, and drop again. The protection is a preference for keeping "what I was just doing"
// intact; it was never meant to be the reason a switch is refused. See
// `shrinkConversationToBudget` for the recorded case that forced this.

export interface ShrinkOptions {
  keepRecentTurns?: number
  maxInputChars?: number
  maxIndexedPrompts?: number
  promptIndexChars?: number
  /**
   * Whether the drop rung (rung 5) lifts developer-role messages out of the
   * dropped range and keeps them after the marker. Defaults to `true`.
   *
   * WHY this is an option and not a constant, and WHY the default is `true`:
   * the census case for retention (finding 4) is about what a *source* thread
   * contains, but whether retention is worth anything depends on what the
   * *target* persists — and this module must never know which target that is.
   * Only the caller does. `true` keeps the provider-neutral behaviour the
   * evidence supports; a caller whose target discards developer messages sets
   * `false` so the ladder does not charge budget for content that will be
   * deleted on arrival. `planConversationContext` is that caller.
   */
  keepDeveloperMessages?: boolean
}

export interface ShrinkReport {
  strippedCompactions: number
  clearedResults: number
  /**
   * NET characters saved, i.e. after the replacement placeholder is counted.
   * Clearing a 4,000-character output that is replaced by a 58-character
   * placeholder reports 3,942, not 4,000 — the report is the host's only
   * evidence of what the switch cost the user, so it states the real delta.
   * The same holds for `trimmedChars` and its truncation marker.
   */
  clearedChars: number
  trimmedInputs: number
  /** NET characters saved; see `clearedChars`. */
  trimmedChars: number
  /**
   * Attachment content items — `image`, `document` and `opaque` blocks inside
   * messages — replaced with a text placeholder by rung 3. Counted per item,
   * not per message: a prompt with two screenshots that both went reports 2,
   * because that is what the user lost.
   */
  clearedAttachments: number
  /** NET characters saved; see `clearedChars`. */
  clearedAttachmentChars: number
  droppedEntries: number
  /**
   * Every dropped user message, including ones that carried no text (an image
   * or document prompt). The prompt index in the marker lists only the ones
   * that had text, so `promptIndexLength` can be zero while this is not.
   *
   * Since rung 3 exists, an attachment-only prompt whose attachment was
   * cleared DOES have text by the time the drop rung sees it — its placeholder —
   * and is indexed as `1. [image omitted during provider switch]`. That is
   * left as is on purpose: "the user showed something here" is a truer index
   * entry than silence, and it is the ladder's words, never invented prose.
   */
  droppedTurns: number
  /**
   * Developer-role messages the drop rung lifted out of the dropped range and kept.
   * Zero when `keepDeveloperMessages` was false — in which case they were
   * dropped with their turns and are counted in `droppedEntries`.
   */
  retainedDeveloperMessages: number
  /** Characters the marker's prompt index occupies, after budget trimming. */
  promptIndexLength: number
  /**
   * True when the clearing rungs had to run a second time WITHOUT the
   * recent-turn protection, because the protected suffix alone exceeded the
   * budget. The counters above already include what that second pass removed;
   * this flag exists so a host can tell the user that the newest turns were
   * trimmed too, which the protection otherwise promises never happens.
   */
  liftedRecentTurnProtection: boolean
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
    // Two genuinely different failures reach here and the message must not
    // conflate them: a conversation with no earlier boundary to cut back to was
    // never cut at all, so calling its full estimate "the smallest suffix the
    // ladder can produce" would misdescribe what was tried.
    const cause = report.droppedEntries === 0 && report.droppedTurns === 0
      ? `it has no earlier turn boundary to cut back to, and its retained content is ${report.estimatedCharactersAfter} characters`
      : `the smallest complete suffix the ladder can produce is ${report.estimatedCharactersAfter} characters`
    super(`Conversation cannot fit the target budget of ${report.budgetCharacters} characters: ${cause}.`)
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
  keepDeveloperMessages: true,
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
    // WHY an already-cleared output is skipped rather than re-measured: the
    // ladder's second pass runs this rung again over entries the first pass
    // already cleared. The placeholder is itself a string whose length differs
    // from the number it quotes by a character or two, so re-clearing it would
    // "save" two characters, count the same result twice and flip
    // `liftedRecentTurnProtection` on a conversation where nothing real was
    // removed. The report must describe what the user lost, not the rung's own
    // arithmetic, so a placeholder is terminal.
    if (isClearedPlaceholder(entry.output)) continue
    const before = estimateEntryCharacters(entry)
    // The number quoted to the model is the RAW payload length it lost, not the
    // serialized budget estimate: a reader of "cleared: 4002 characters" is
    // being told how much output vanished, and JSON quoting and escaping are
    // the parser's arithmetic, not theirs.
    const replaced: ConversationToolResult = { ...entry, output: clearedPlaceholder(rawLength(entry.output)) }
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
 * Rung 3. Replace attachment payloads inside messages with a placeholder,
 * oldest first.
 *
 * WHY message content is a rung at all, when the census measured tool results
 * as where the bytes are: the census measured what the ladder could see, and
 * the ladder could not see this. A real Claude transcript recorded on
 * 2026-09-18 ended with a 15-character prompt carrying a 549,526-character
 * base64 screenshot, two turns after a 129-character prompt carrying a
 * 713,997-character `opaque` block (an OpenCode `file` part that an earlier
 * switch had copied into the Claude file). Against a 288,000-character budget
 * the ladder cleared 256 outputs, trimmed 3 inputs, dropped 15 turns and then
 * threw, because the newest turn was 99.98 % one image and rungs 2 and 4 only
 * ever look at tool entries. Nothing about that transcript was exotic: pasting
 * a screenshot is how a user shows an agent a UI bug.
 *
 * WHY `image`, `document` AND `opaque` items, rather than images alone: all
 * three are non-text payload the model has already consumed and answered. The
 * distinction that matters to the ladder is authored words versus consumed
 * input — the same line rung 2 draws between a tool's output and the model's
 * reply. An `opaque` item in a message is, in addition, content every
 * cross-provider projector drops on arrival, so leaving it in place charges the
 * budget for bytes the target never sees. Text items are never touched: they
 * are the user's or the model's own words, and a ladder that shortened a prompt
 * would be rewriting what was asked.
 *
 * WHY the placeholder is `[<image|document|attachment> omitted during provider
 * switch]` with no size, unlike rung 2's: a tool output's character count tells
 * the model roughly how much text vanished; a base64 payload's count tells it
 * nothing. The numbers live in the report, which is for the host and the user.
 *
 * WHY it sits between clearing results and trimming inputs: rung ordering is
 * "what the loss costs the target model, cheapest first". A stale screenshot is
 * consumed input like a stale tool output, and the assistant's reply to it
 * normally describes what it saw. Tool-call inputs (rung 4) hold the edits the
 * session made, which the target can read back nowhere else once the files have
 * moved on. Dropping whole turns (rung 5) is strictly worse than any of these.
 *
 * Items are replaced one at a time, re-measuring the whole message after each,
 * because the budget estimate is the serialized message and JSON escaping makes
 * savings non-additive. The same net-savings guard as rung 2 applies: an item
 * shorter than its placeholder is left alone so the report can never claim a
 * saving while the conversation grew.
 */
export function clearAttachments(
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
    if (entry.kind !== 'message' || !entry.content.some(isAttachment)) continue
    let current: ConversationMessage = entry
    for (let position = 0; position < current.content.length && total > budgetCharacters; position += 1) {
      const item = current.content[position]!
      if (!isAttachment(item)) continue
      const before = estimateEntryCharacters(current)
      const content = [...current.content]
      content[position] = { kind: 'text', text: attachmentPlaceholder(item) }
      const replaced: ConversationMessage = { ...current, content }
      const after = estimateEntryCharacters(replaced)
      if (after >= before) continue
      current = replaced
      total -= before - after
      cleared += 1
      clearedChars += before - after
    }
    if (current !== entry) entries[index] = current
  }
  return {
    conversation: cleared === 0 ? conversation : { ...conversation, entries },
    cleared,
    clearedChars,
  }
}

/**
 * Rung 4. Truncate tool-call inputs above `maxInputChars`, oldest first.
 *
 * Only reached when clearing every reachable result and attachment was not
 * enough. The census measured the first half of that sentence only: with every
 * tool result cleared, about half of real over-budget transcripts were still
 * over. It could not see attachments (see rung 3), so how often this rung fires
 * now is unmeasured.
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
 * Rung 5. Drop whole oldest turns and explain the loss in a synthetic marker.
 *
 * Two invariants make this rung safe to ship:
 *
 * 1. **Never cut inside a turn.** The retained history always begins at a safe
 *    resume boundary (a user message or a compaction), so the target never
 *    receives an orphaned tool result or a half-finished assistant reply.
 * 2. **Never drop a developer message, unless the caller says the target will
 *    discard it anyway.** Census finding 4: Codex developer messages are 36.9 %
 *    of the repeatedly-compacted fixture's characters, and they are the
 *    replacement history and standing user instructions that survive a remote
 *    compaction — on a compacted Codex thread they are the ONLY plaintext left
 *    in the file. A ladder that dropped them would delete the conversation
 *    while reporting that it merely trimmed some turns. They are therefore
 *    retained after the marker, in their original relative order, and they
 *    still count against the budget: if they alone exceed it,
 *    `stillExceedsBudget` is the honest answer and the caller throws rather
 *    than pretending a lossier cut would have helped.
 *
 *    `keepDeveloperMessages: false` inverts that, and exists because retention
 *    is only worth budget if the target persists the role at all. When it is
 *    false, developer messages are dropped with their turns like any other
 *    entry, cost nothing, and are counted in `droppedEntries` — but the marker
 *    still says how many were lost, because a silent deletion of the only
 *    plaintext in a compacted thread is exactly what invariant 2 exists to
 *    prevent. Deciding which targets those are is the planner's job; this
 *    module never learns a provider name.
 */
export function dropOldestTurns(
  conversation: ConversationDocument,
  budgetCharacters: number,
  options: ShrinkOptions = {},
): {
  conversation: ConversationDocument
  droppedEntries: number
  droppedTurns: number
  retainedDeveloperMessages: number
  promptIndexLength: number
  stillExceedsBudget: boolean
} {
  const maxIndexedPrompts = options.maxIndexedPrompts ?? DEFAULTS.maxIndexedPrompts
  const promptIndexChars = options.promptIndexChars ?? DEFAULTS.promptIndexChars
  const keepDeveloperMessages = options.keepDeveloperMessages ?? DEFAULTS.keepDeveloperMessages
  const entries = conversation.entries
  const costs = entries.map(estimateEntryCharacters)
  const total = costs.reduce((sum, cost) => sum + cost, 0)
  if (total <= budgetCharacters) {
    return {
      conversation,
      droppedEntries: 0,
      droppedTurns: 0,
      retainedDeveloperMessages: 0,
      promptIndexLength: 0,
      stillExceedsBudget: false,
    }
  }

  // `suffixCost[i]` is what entries[i..] costs; `developerPrefixCost[i]` is
  // what the developer messages BEFORE i cost, because those survive the cut
  // wherever it lands (and is all zeros when they do not). Retaining at
  // boundary i therefore costs the sum of the two, and that sum is
  // non-increasing in i — a developer message moves from one accumulator to
  // the other as i grows, never appearing in both — so the FIRST boundary that
  // fits, scanning oldest to newest, keeps the most history and the loop below
  // can stop there.
  //
  // Precomputing both makes the *cost test* per boundary O(1) rather than O(n).
  // Building the cut itself is still O(n), but it happens only for boundaries
  // that already passed the cost test — in practice once, and at most a couple
  // of times when the marker's own headline does not fit.
  const suffixCost = new Array<number>(entries.length + 1).fill(0)
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    suffixCost[index] = suffixCost[index + 1]! + costs[index]!
  }
  const developerPrefixCost = new Array<number>(entries.length + 1).fill(0)
  for (let index = 0; index < entries.length; index += 1) {
    developerPrefixCost[index + 1] = developerPrefixCost[index]! +
      (keepDeveloperMessages && isDeveloperMessage(entries[index]!) ? costs[index]! : 0)
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
      keepDeveloperMessages,
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
      retainedDeveloperMessages: 0,
      promptIndexLength: 0,
      stillExceedsBudget: true,
    }
  }
  const cut = assembleCut(
    conversation,
    lastBoundary,
    0,
    maxIndexedPrompts,
    promptIndexChars,
    keepDeveloperMessages,
  )
  return { ...cut.result, stillExceedsBudget: true }
}

/**
 * The ladder itself: rungs in order, each applied only as far as needed.
 *
 * WHY there is a second pass, and WHY it re-runs the clearing rungs on the
 * conversation as it stood BEFORE the drop rung rather than on the drop rung's
 * fallback cut:
 *
 * The recent-turn protection keeps rungs 2–4 off the newest `keepRecentTurns`
 * user turns. When those turns alone exceed the budget, the drop rung cannot
 * fit any boundary and used to fall back to "keep the last complete turn whole
 * and throw". That fallback was written to refuse a *fragment* — a transcript
 * that starts mid-turn — and it is still right to refuse one. But the last turn
 * being too big was not evidence that only a fragment would fit; it was
 * evidence that the protection had walled off the only payload left to
 * reclaim. The recorded case (see `clearAttachments`) was a 15-character
 * prompt with a 549,526-character screenshot: complete, safe to open on, and
 * refused for the sake of a preference about recency.
 *
 * The design already relaxes the protection when it would cover the WHOLE
 * conversation (`protectedFromIndex`, the single-turn case), on the argument
 * that declaring a session unfittable while nine tenths of it is stale payload
 * is a worse answer than the evidence supports. The second pass is the same
 * argument applied whenever the protected suffix is the thing that does not
 * fit. Re-running on the pre-drop conversation rather than on the fallback cut
 * keeps the ladder's ordering principle intact: once recent payload is on the
 * table, clearing it may make room for old turns that the first drop attempt
 * would have thrown away, and the drop rung then removes only what is still
 * necessary. Running only on the last turn would lose every earlier turn for
 * certain.
 *
 * WHY the lift tries SUBSETS of the clearing rungs instead of simply running
 * all three: each rung stops only when the whole conversation fits, and inside
 * the lifted range it usually cannot — the range was entered because one thing
 * in it is enormous. Running rungs 2→3→4 unconditionally therefore cleared
 * every recent tool output on its way to the pasted image that was the actual
 * cause. Measured in review on a transcript whose newest turn held one 549k
 * image: 60k of the freshest outputs were replaced by placeholders and the SAME
 * five turns were retained as when only the image was cleared; on the recorded
 * transcript `clearedResults` went 256 → 262 while 97.6 % of the budget went
 * unused. The freshest outputs are exactly what the protection exists for.
 *
 * So the lift first runs all three rungs to learn how much history is
 * achievable at all, then re-tries the cheaper subsets in ladder-cost order
 * (`LIFTED_SUBSETS`) and takes the first one that still fits AND drops no more
 * entries than the full lift did. "Keep as much history as possible" outranks
 * "touch as little recent payload as possible", because clearing payload is
 * cheaper than dropping turns everywhere else on this ladder; the subset search
 * only removes loss that bought nothing. It costs at most four drop attempts on
 * a path that used to be an exception. Known residual: WITHIN a rung the walk
 * is still oldest-first to exhaustion, so a subset that includes rung 2 clears
 * every recent output even when one of them was the problem. Largest-first
 * inside the lifted range is the better eventual shape.
 *
 * The lift is reported (`liftedRecentTurnProtection`), because the protection
 * is a promise the host may have relayed to the user and principle 3 says a
 * broken promise is not silent either. It is set only when the second pass
 * actually removed something: a conversation whose newest turn is 300k
 * characters of the user's own prose still throws, with the flag false, since
 * there was nothing the lift could legitimately take.
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
    clearedAttachments: 0,
    clearedAttachmentChars: 0,
    droppedEntries: 0,
    droppedTurns: 0,
    retainedDeveloperMessages: 0,
    promptIndexLength: 0,
    liftedRecentTurnProtection: false,
    estimatedCharactersBefore: estimateConversationCharacters(conversation),
    estimatedCharactersAfter: 0,
    budgetCharacters,
  }

  // Rung 1: encrypted, incomplete and rejected compactions carry nothing a
  // foreign target can read; the records they summarized are still here.
  const stripped = stripNativeOnlyCompactions(conversation)
  report.strippedCompactions = stripped.stripped

  // Rungs 2–4 with the recent-turn protection, then rung 5.
  const protectedPass = clearPayloads(stripped.conversation, budgetCharacters, options, ALL_CLEARING_RUNGS)
  addPayloadCounts(report, protectedPass.counts)
  let dropped = dropOldestTurns(protectedPass.conversation, budgetCharacters, options)

  if (dropped.stillExceedsBudget) {
    // Second pass: the protected suffix alone is over budget.
    const lifted = liftProtection(protectedPass.conversation, budgetCharacters, options)
    if (lifted !== null) {
      addPayloadCounts(report, lifted.counts)
      report.liftedRecentTurnProtection = true
      dropped = lifted.dropped
    }
  }
  report.droppedEntries = dropped.droppedEntries
  report.droppedTurns = dropped.droppedTurns
  report.retainedDeveloperMessages = dropped.retainedDeveloperMessages
  report.promptIndexLength = dropped.promptIndexLength
  const current = dropped.conversation

  report.estimatedCharactersAfter = estimateConversationCharacters(current)
  if (dropped.stillExceedsBudget || report.estimatedCharactersAfter > budgetCharacters) {
    throw new ConversationUnfittableError(report)
  }
  return { conversation: current, report }
}

type ClearingRung = 'results' | 'attachments' | 'inputs'

const ALL_CLEARING_RUNGS: readonly ClearingRung[] = ['results', 'attachments', 'inputs']

/**
 * The cheaper-than-everything subsets the lift tries, in ladder-cost order:
 * outputs are the cheapest thing to lose, then attachments, then both. Inputs
 * never appear without the other two — they hold the session's edits and are
 * the last payload this ladder touches anywhere. The full set is not listed:
 * it is what `liftProtection` measures first and falls back to.
 */
const LIFTED_SUBSETS: ReadonlyArray<readonly ClearingRung[]> = [
  ['results'],
  ['attachments'],
  ['results', 'attachments'],
]

interface PayloadCounts {
  clearedResults: number
  clearedChars: number
  clearedAttachments: number
  clearedAttachmentChars: number
  trimmedInputs: number
  trimmedChars: number
}

/**
 * The chosen rungs in LADDER order (2, 3, 4) whatever order `rungs` lists them
 * in, each only as far as needed. Shared by both passes so they cannot drift in
 * rung order or in what they count.
 *
 * WHY this returns counts instead of writing into the report: the lift runs
 * several candidate subsets and keeps one. Counting straight into the report
 * would charge the user for clearings that were tried and thrown away — and the
 * report is the host's only evidence of what the switch cost.
 *
 * Rung 2: tool outputs are the bulk of coding sessions (median 71.8 % of
 * characters) and the cheapest thing to lose; the model's own words and every
 * edit input survive. Rung 3: attachment payload inside messages, consumed
 * input like an output. Rung 4: oversized inputs (whole-file writes) beyond a
 * cap.
 */
function clearPayloads(
  conversation: ConversationDocument,
  budgetCharacters: number,
  options: ShrinkOptions,
  rungs: readonly ClearingRung[],
): { conversation: ConversationDocument; counts: PayloadCounts } {
  const counts: PayloadCounts = {
    clearedResults: 0,
    clearedChars: 0,
    clearedAttachments: 0,
    clearedAttachmentChars: 0,
    trimmedInputs: 0,
    trimmedChars: 0,
  }
  let current = conversation
  if (rungs.includes('results')) {
    const cleared = clearToolResults(current, budgetCharacters, options)
    counts.clearedResults = cleared.cleared
    counts.clearedChars = cleared.clearedChars
    current = cleared.conversation
  }
  if (rungs.includes('attachments')) {
    const attachments = clearAttachments(current, budgetCharacters, options)
    counts.clearedAttachments = attachments.cleared
    counts.clearedAttachmentChars = attachments.clearedChars
    current = attachments.conversation
  }
  if (rungs.includes('inputs')) {
    const trimmed = trimToolInputs(current, budgetCharacters, options)
    counts.trimmedInputs = trimmed.trimmed
    counts.trimmedChars = trimmed.trimmedChars
    current = trimmed.conversation
  }
  return { conversation: current, counts }
}

function addPayloadCounts(report: ShrinkReport, counts: PayloadCounts): void {
  report.clearedResults += counts.clearedResults
  report.clearedChars += counts.clearedChars
  report.clearedAttachments += counts.clearedAttachments
  report.clearedAttachmentChars += counts.clearedAttachmentChars
  report.trimmedInputs += counts.trimmedInputs
  report.trimmedChars += counts.trimmedChars
}

/**
 * The second pass. Returns `null` when lifting the protection removed nothing,
 * so the caller keeps the first pass's verdict and the report's flag stays
 * false.
 *
 * WHY "removed nothing" is read from the COUNTS and not from whether a rung
 * handed back a new object: the rungs do return their input by identity when
 * they change nothing, but that is three separate return statements nobody
 * promised to keep in step. A future rung that always copied would have set
 * the flag on every lift, and the host toast would say "newest turns trimmed"
 * for a switch that then threw. The counts are the contract; they only move
 * when something real was removed, which is also why rungs 2 and 4 treat their
 * own placeholder and marker as terminal.
 *
 * See `shrinkConversationToBudget` for why subsets are tried at all and how the
 * winner is chosen.
 */
function liftProtection(
  conversation: ConversationDocument,
  budgetCharacters: number,
  options: ShrinkOptions,
): { counts: PayloadCounts; dropped: ReturnType<typeof dropOldestTurns> } | null {
  const unprotected: ShrinkOptions = { ...options, keepRecentTurns: 0 }
  const attempt = (rungs: readonly ClearingRung[]) => {
    const cleared = clearPayloads(conversation, budgetCharacters, unprotected, rungs)
    return {
      counts: cleared.counts,
      dropped: dropOldestTurns(cleared.conversation, budgetCharacters, options),
    }
  }

  const full = attempt(ALL_CLEARING_RUNGS)
  const removed = full.counts.clearedResults + full.counts.clearedAttachments + full.counts.trimmedInputs
  if (removed === 0) return null
  // Still does not fit with everything on the table: report what the full lift
  // took, because that is what was tried before the ladder gave up.
  if (full.dropped.stillExceedsBudget) return full

  for (const rungs of LIFTED_SUBSETS) {
    const candidate = attempt(rungs)
    if (candidate.dropped.stillExceedsBudget) continue
    // `droppedEntries` is strictly increasing in the cut boundary (every later
    // boundary adds at least the user message at the earlier one), so "drops no
    // more entries" is exactly "keeps at least as much history".
    if (candidate.dropped.droppedEntries <= full.dropped.droppedEntries) return candidate
  }
  return full
}

const CLEARED_PLACEHOLDER_PREFIX = '[tool output cleared during provider switch: '

function clearedPlaceholder(chars: number): string {
  return `${CLEARED_PLACEHOLDER_PREFIX}${chars} characters]`
}

// WHY the whole placeholder is matched and not just its prefix: a legitimate
// tool output can BEGIN with these words — an agent that `cat`s a transcript
// this ladder already shrank, or this package's own fixtures. A prefix test
// made such an output permanently unclearable (observed in review: a 60k
// output with the prefix cleared nothing and the ladder dropped its whole turn
// instead). Only the exact string this module writes is terminal.
const CLEARED_PLACEHOLDER = /^\[tool output cleared during provider switch: \d+ characters\]$/

function isClearedPlaceholder(output: unknown): boolean {
  return typeof output === 'string' && CLEARED_PLACEHOLDER.test(output)
}

/**
 * The payload length a reader would recognise: a string output's own length,
 * and the serialized length of anything else (Claude persists structured
 * `tool_result` content, Codex a list). Deliberately NOT
 * `estimateEntryCharacters`, which adds JSON quoting the model never sees.
 */
function rawLength(output: unknown): number {
  return typeof output === 'string' ? output.length : printableLength(output)
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
 * is off limits to the clearing rungs (2 to 4) on the ladder's first pass.
 *
 * Three cases, and the two boundaries between them are the whole point.
 *
 * **More than `keepRecentTurns` turns** — the ordinary case, and the rule as
 * specified: protect the last `keepRecentTurns` turns.
 *
 * **Exactly one turn** — protect nothing. The rule exists to keep "what I was
 * just doing" intact, which is a statement about the boundary between old
 * history and recent work; a single-turn conversation has no such boundary, so
 * applying it literally protects 100 % of the transcript and makes the entire
 * ladder a no-op. That is not hypothetical: `claude-sequence-oversized` is a
 * real transcript with 67 entries, exactly ONE user message, 92.1 % of its
 * characters in tool results, and 1.11× the Codex budget. The census counts it
 * among the 45 of 91 oversized transcripts that clearing tool results alone
 * fixes, and that population measurement cleared every result with no
 * recent-turn protection at all. Declaring such a session unfittable while
 * nine tenths of it is stale tool output would be a worse answer than the
 * evidence supports.
 *
 * **Two to `keepRecentTurns` turns** — protect the final turn only. WHY not
 * "protect nothing" here too, which is the simpler rule: at exactly
 * `keepRecentTurns` turns that would make the NEWEST turn clearable, which is
 * the precise thing the protection exists to forbid, and it would do so at the
 * moment the option's value is met rather than exceeded — a discontinuity with
 * no argument behind it. Protecting the final turn keeps the guarantee that
 * matters (the work in progress survives) while still letting the ladder reach
 * the older turns, which is what the single-turn case showed is necessary.
 *
 * In every case the walk order supplies a weaker guarantee underneath: rungs 2
 * to 4 go oldest first and stop the instant the estimate fits, so the newest
 * outputs are always the last to go.
 */
function protectedFromIndex(
  entries: readonly ConversationEntry[],
  keepRecentTurns: number,
): number {
  const starts = userTurnStarts(entries)
  if (keepRecentTurns <= 0 || starts.length <= 1) return entries.length
  if (starts.length <= keepRecentTurns) return starts[starts.length - 1] ?? entries.length
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
 * decoded entry keeps it that way.
 *
 * WHY both branches measure with `printableLength` and treat `maxInputChars` as
 * a cap on the SERIALIZED result including the truncation marker: the budget
 * this rung is trying to satisfy is
 * `estimateEntryCharacters` — `printableLength({ name, input })` — so a cap
 * applied to a raw string's own `.length` is a different quantity from the one
 * being budgeted, and the two silently disagree by the quoting and escaping
 * that JSON adds. Measuring the same way in both places is what makes "the
 * arithmetic here and the budget arithmetic there cannot disagree" true rather
 * than approximately true. Because escaping is not linear in the number of
 * characters kept, the keep length is found by measurement (a binary search on
 * the serialized result) rather than by subtraction.
 *
 * OUT OF SCOPE, deliberately: strings nested inside a member object or array
 * are not trimmed, only the record's own string-valued members. A tool input
 * whose bulk is buried two levels down is left to the drop rung. Recursing
 * would mean deciding which nested key is safe to gut without knowing any
 * tool's schema, which is exactly the provider knowledge this module does not
 * have.
 */
function trimToolCallInput(input: unknown, maxInputChars: number): unknown | null {
  if (typeof input === 'string') {
    if (printableLength(input) <= maxInputChars) return null
    if (isTrimmedValue(input)) return null
    return truncateToSerializedCap(input, maxInputChars)
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null
  const original = input as Record<string, unknown>
  if (printableLength(original) <= maxInputChars) return null

  const next: Record<string, unknown> = { ...original }
  // WHY a member that already ends in the trim marker is skipped: the ladder's
  // second pass visits every tool call again. A second visit is harmless when
  // the first one got the object under the cap (the size check above returns),
  // but it could not when the bulk is NESTED (`edits: [...]`, out of scope by
  // this function's own contract). Then the marker written on the first visit is
  // a string member like any other; re-truncating it to zero kept characters
  // rewrites `103 characters omitted` as `68 characters omitted` — 68 being the
  // length of the previous MARKER — which is a character shorter, passes the
  // net-savings guard, and was counted as a second trim. Observed in review:
  // `trimmedInputs: 3` for a conversation with two tool calls, a marker quoting
  // the wrong loss, and `liftedRecentTurnProtection: true` on a switch where
  // nothing real was removed. The marker is the only thing the target is told
  // about the loss, so once written it is terminal — the same rule rung 2
  // applies to its placeholder.
  const stringKeys = Object.keys(next)
    .filter(key => typeof next[key] === 'string' && !isTrimmedValue(next[key] as string))
    .sort((a, b) => (next[b] as string).length - (next[a] as string).length)
  let changed = false
  for (const key of stringKeys) {
    if (printableLength(next) <= maxInputChars) break
    const value = next[key] as string
    // Largest truncation of THIS member that brings the whole object under the
    // cap. When even an empty member cannot (the record's keys and non-string
    // values already exceed it), take the smallest form anyway and let the next
    // member — and ultimately the drop rung — deal with the remainder.
    let low = 0
    let high = value.length
    let best: string | null = null
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const candidate = truncateWithMarker(value, middle)
      next[key] = candidate
      if (printableLength(next) <= maxInputChars) {
        best = candidate
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    const chosen = best ?? truncateWithMarker(value, 0)
    if (chosen.length < value.length) {
      next[key] = chosen
      changed = true
    } else {
      next[key] = value
    }
  }
  return changed ? next : null
}

/**
 * The longest truncation of `text` whose serialized form fits `cap`, or `null`
 * when not even the bare marker does.
 */
function truncateToSerializedCap(text: string, cap: number): string | null {
  if (printableLength(truncateWithMarker(text, 0)) > cap) return null
  let low = 0
  let high = text.length
  let best = truncateWithMarker(text, 0)
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = truncateWithMarker(text, middle)
    if (printableLength(candidate) <= cap) {
      best = candidate
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return printableLength(best) < printableLength(text) ? best : null
}

const TRIMMED_MARKER = /\n\[tool input trimmed during provider switch: \d+ characters omitted\]$/

function isTrimmedValue(text: string): boolean {
  return TRIMMED_MARKER.test(text)
}

function truncateWithMarker(text: string, keep: number): string {
  const omitted = text.length - keep
  return `${text.slice(0, keep)}\n[tool input trimmed during provider switch: ${omitted} characters omitted]`
}

/**
 * Anything in a message that is not the author's words. `image` and
 * `document` are attachments by definition; an `opaque` item is a block this
 * parser did not recognise, which every cross-provider projector drops — so
 * for budget purposes it is payload, never prose.
 */
function isAttachment(content: ConversationContent): boolean {
  return content.kind !== 'text'
}

function attachmentPlaceholder(content: ConversationContent): string {
  const noun = content.kind === 'image'
    ? 'image'
    : content.kind === 'document'
      ? 'document'
      : 'attachment'
  return `[${noun} omitted during provider switch]`
}

function isDeveloperMessage(entry: ConversationEntry): entry is ConversationMessage {
  return entry.kind === 'message' && entry.role === 'developer'
}

function isUserMessage(entry: ConversationEntry): entry is ConversationMessage {
  return entry.kind === 'message' && entry.role === 'user'
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
    retainedDeveloperMessages: number
    promptIndexLength: number
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
  keepDeveloperMessages: boolean,
): AssembledCut {
  const dropped = conversation.entries.slice(0, startIndex)
  const kept = conversation.entries.slice(startIndex)
  const developers = dropped.filter(isDeveloperMessage)
  const retainedDevelopers = keepDeveloperMessages ? developers : []
  const removedEntries = dropped.length - retainedDevelopers.length
  // Every dropped user message counts as a dropped turn, including one that
  // carried only an image or a document: the user asked something there, and a
  // count that quietly excluded it would understate what the switch cost. The
  // prompt index below lists only the ones that left text to quote.
  const droppedTurns = dropped.filter(isUserMessage).length
  const prompts = dropped.filter(isUserMessage).map(promptText).filter(text => text.length > 0)
  const carried = [...dropped].reverse().find(
    (entry): entry is ConversationCompaction => (
      entry.kind === 'compaction' && entry.summary.trim().length > 0
    ),
  )?.summary

  const compose = (
    withCarried: string | undefined,
    shownPrompts: readonly string[],
  ): { text: string; indexChars: number } => composeMarkerSummary({
    carried: withCarried,
    removedEntries,
    droppedTurns,
    prompts,
    shown: shownPrompts,
    developerMessages: developers.length,
    developersRetained: keepDeveloperMessages,
  })

  let shown = prompts.slice(-maxIndexedPrompts).map(text => text.slice(0, promptIndexChars))
  let summary = compose(carried, shown)
  while (summary.text.length > room && shown.length > 0) {
    shown = shown.slice(1)
    summary = compose(carried, shown)
  }
  if (summary.text.length > room && carried !== undefined) {
    summary = compose(undefined, shown)
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
      droppedTurns,
      retainedDeveloperMessages: retainedDevelopers.length,
      promptIndexLength: summary.indexChars,
    },
  }
}

function composeMarkerSummary(input: {
  carried: string | undefined
  removedEntries: number
  droppedTurns: number
  prompts: readonly string[]
  shown: readonly string[]
  developerMessages: number
  developersRetained: boolean
}): { text: string; indexChars: number } {
  const { carried, removedEntries, droppedTurns, prompts, shown } = input
  const offset = prompts.length - shown.length
  const index = shown.map((text, position) => `${offset + position + 1}. ${text}`).join('\n')
  // The count is stated whether or not they were kept. A reader who sees a
  // compacted thread arrive with no developer content needs to know it existed
  // and where it went; the promise of retention is made only when it is true.
  const plural = input.developerMessages === 1 ? '' : 's'
  const developerNote = input.developerMessages === 0
    ? ''
    : input.developersRetained
      ? ` The ${input.developerMessages} developer message${plural} that preceded the cut are retained immediately below this marker; on a compacted thread they are the only plaintext history left.`
      : ` ${input.developerMessages} developer message${plural} preceded the cut and were omitted with their turns, because the target does not persist a developer role.`
  const indexNote = shown.length === 0
    ? ''
    : ` The earlier prompts, oldest first${prompts.length > shown.length ? ` (last ${shown.length} shown)` : ''}:\n${index}`
  const headline =
    `[Provider switch omitted ${removedEntries} earlier entries across ${droppedTurns} user turns ` +
    `so the session fits the target model.${developerNote} ` +
    `The retained history begins at the next complete user turn.${indexNote}]`
  return {
    text: [carried, headline].filter(Boolean).join('\n\n'),
    indexChars: index.length,
  }
}

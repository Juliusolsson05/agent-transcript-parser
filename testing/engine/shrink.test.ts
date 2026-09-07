import { describe, expect, it } from 'vitest'

import type { ConversationDocument, ConversationEntry } from '../../src/conversation/types.js'
import {
  ConversationUnfittableError,
  clearToolResults,
  dropOldestTurns,
  estimateConversationCharacters,
  shrinkConversationToBudget,
  stripNativeOnlyCompactions,
  trimToolInputs,
} from '../../src/index.js'
import {
  CENSUS_OVERSIZED_TURNS_PAYLOADS,
  claude,
  codex,
  withCensusToolPayloads,
} from './fixtureConversations.js'

// WHY every budget in this file is a fraction of the fixture's own estimate
// instead of the real 581,400-character Codex budget the census measures
// against: redaction collapses these fixtures to 0.3–2.4 % of their real size
// (census §"Caveats", caveat 1), so an absolute budget either fits every
// fixture trivially or fits none of them. A relative budget asks the same
// question the real one does — "this conversation is N times its target
// window" — at whatever scale the committed bytes happen to have.

describe('stripNativeOnlyCompactions', () => {
  it('drops every encrypted Codex compaction and keeps the raw records around it', async () => {
    const conversation = await codex('codex-sequence-compacted-multi')
    const encrypted = conversation.entries.filter(entry => entry.kind === 'compaction').length
    expect(encrypted).toBe(4)

    const { conversation: stripped, stripped: count } = stripNativeOnlyCompactions(conversation)

    expect(count).toBe(encrypted)
    expect(stripped.entries.some(entry => entry.kind === 'compaction')).toBe(false)
    // Census finding 5: a Codex compaction summary decodes empty, so removing
    // it costs nothing, while every record it summarized is still on disk.
    expect(stripped.entries.filter(entry => entry.kind === 'message').length)
      .toBe(conversation.entries.filter(entry => entry.kind === 'message').length)
  })

  it('keeps the pre-compaction history of the majority-shape Codex rollout', async () => {
    // Census finding 6: 211 of 230 single-compaction rollouts (91.7 %) hold a
    // median 74.3 % of their characters BEFORE the compaction. This fixture is
    // that shape — the compaction sits at entry 23 of 83. Discarding the
    // records ahead of it "because the rollout is compacted" would throw away
    // roughly three quarters of the recoverable history in the typical case.
    const conversation = await codex('codex-sequence-compacted-history')
    const compactionIndex = conversation.entries.findIndex(entry => entry.kind === 'compaction')
    expect(compactionIndex).toBe(23)
    const before = conversation.entries.slice(0, compactionIndex)

    const { conversation: stripped, stripped: count } = stripNativeOnlyCompactions(conversation)

    expect(count).toBe(1)
    expect(stripped.entries.slice(0, compactionIndex)).toEqual(before)
    expect(stripped.entries).toHaveLength(conversation.entries.length - 1)
  })
})

describe('clearToolResults', () => {
  it('clears oldest results first and never touches the last three user turns', async () => {
    const conversation = withCensusToolPayloads(
      await claude('claude-sequence-oversized-turns'),
      CENSUS_OVERSIZED_TURNS_PAYLOADS,
    )
    const before = estimateConversationCharacters(conversation)
    const { conversation: cleared, cleared: count, clearedChars } = clearToolResults(
      conversation,
      Math.floor(before * 0.5),
      { keepRecentTurns: 3 },
    )

    expect(count).toBeGreaterThan(0)
    expect(clearedChars).toBeGreaterThan(0)
    expect(estimateConversationCharacters(cleared)).toBe(before - clearedChars)

    // Every tool call keeps its input intact: the census puts 27.7 % of this
    // transcript's characters in tool-call inputs (Claude Write/Edit payloads),
    // and those are the edits the target must still be able to read back.
    expect(cleared.entries.filter(isToolCall).map(entry => JSON.stringify(entry.input)))
      .toEqual(conversation.entries.filter(isToolCall).map(entry => JSON.stringify(entry.input)))

    // Results inside the last three user turns are untouched.
    const userIndexes = indexesOfUserMessages(cleared.entries)
    const protectedFrom = userIndexes.at(-3)!
    for (let index = protectedFrom; index < cleared.entries.length; index += 1) {
      expect(cleared.entries[index]).toEqual(conversation.entries[index])
    }
    // ...and the first thing cleared is genuinely the oldest clearable result.
    const firstChanged = cleared.entries.findIndex((entry, index) => entry !== conversation.entries[index])
    const firstResult = cleared.entries.findIndex(entry => entry.kind === 'tool-result')
    expect(firstChanged).toBe(firstResult)
    expect(cleared.entries[firstChanged]).toMatchObject({
      kind: 'tool-result',
      output: expect.stringContaining('[tool output cleared during provider switch:'),
      callId: (conversation.entries[firstChanged] as { callId: string }).callId,
    })
  })

  it('never grows a conversation whose outputs are already shorter than the placeholder', async () => {
    // The committed fixture, unscaled. Its largest tool-result output is 51
    // characters, which is shorter than the placeholder the ladder would write
    // in its place. Clearing must therefore be a no-op rather than a rung that
    // makes the transcript bigger while reporting that it shrank it.
    const conversation = await claude('claude-sequence-oversized-turns')
    const before = estimateConversationCharacters(conversation)

    const result = clearToolResults(conversation, Math.floor(before * 0.25))

    expect(result.cleared).toBe(0)
    expect(result.clearedChars).toBe(0)
    expect(result.conversation).toBe(conversation)
  })

  it('clears a single-turn transcript, which is the case protection must not cover', async () => {
    // `claude-sequence-oversized` has exactly ONE user message and 92.1 % of
    // its characters in tool results, and the census counts it among the 45 of
    // 91 oversized transcripts that clearing tool results alone fixes. A
    // literal "protect the last three turns" would protect 100 % of it and
    // declare it unfittable. At census payload sizes the whole ladder resolves
    // it on rung 2 alone, which is the claim finally being asserted.
    const conversation = withCensusToolPayloads(
      await claude('claude-sequence-oversized'),
      CENSUS_OVERSIZED_TURNS_PAYLOADS,
    )
    const budget = Math.floor(estimateConversationCharacters(conversation) * 0.6)

    const { report } = shrinkConversationToBudget(conversation, budget)

    expect(report.clearedResults).toBeGreaterThan(0)
    expect(report.clearedChars).toBeGreaterThan(0)
    expect(report.droppedTurns).toBe(0)
    expect(report.droppedEntries).toBe(0)
    expect(report.estimatedCharactersAfter).toBeLessThanOrEqual(budget)
  })

  it('still protects the newest turn when the conversation has exactly keepRecentTurns turns', async () => {
    // The boundary the relaxation must NOT cross. With three turns and
    // keepRecentTurns: 3, lifting protection entirely would make the newest
    // turn — the work in progress — the very first thing eligible for
    // clearing. Only the final turn is protected here; the older two are fair
    // game, which is what keeps a short-but-huge session fittable.
    const conversation = turnedConversation(3, 4_000)
    const before = estimateConversationCharacters(conversation)

    const result = clearToolResults(conversation, 5_000, { keepRecentTurns: 3 })

    expect(result.cleared).toBe(2)
    expect(estimateConversationCharacters(result.conversation)).toBeLessThanOrEqual(5_000)
    expect(estimateConversationCharacters(result.conversation)).toBe(before - result.clearedChars)
    // The two older results went; the newest one is byte-identical.
    expect(result.conversation.entries[2]).not.toEqual(conversation.entries[2])
    expect(result.conversation.entries[5]).not.toEqual(conversation.entries[5])
    expect(result.conversation.entries[8]).toEqual(conversation.entries[8])
    // The placeholder quotes the RAW payload length the model lost, not the
    // serialized budget estimate that adds JSON quoting.
    expect(result.conversation.entries[2]).toMatchObject({
      output: '[tool output cleared during provider switch: 4000 characters]',
    })
  })
})

describe('trimToolInputs', () => {
  it('truncates oversized inputs in place while keeping the tool-call object shape', async () => {
    const conversation = withCensusToolPayloads(
      await claude('claude-sequence-oversized-turns'),
      CENSUS_OVERSIZED_TURNS_PAYLOADS,
    )
    const before = estimateConversationCharacters(conversation)
    // maxInputChars is passed explicitly because the census mean input here is
    // 2,390 characters, below the 8,000 production default; the rung's
    // behaviour is what is under test, not the placeholder threshold.
    const result = trimToolInputs(conversation, Math.floor(before * 0.5), { maxInputChars: 1_000 })

    expect(result.trimmed).toBeGreaterThan(0)
    expect(result.trimmedChars).toBeGreaterThan(0)
    expect(estimateConversationCharacters(result.conversation)).toBe(before - result.trimmedChars)

    // maxInputChars is a HARD cap on the serialized input including the
    // truncation marker, measured the same way estimateEntryCharacters
    // measures it — so no trimmed call may exceed it.
    for (const [index, entry] of result.conversation.entries.entries()) {
      if (entry.kind !== 'tool-call' || entry === conversation.entries[index]) continue
      expect(JSON.stringify(entry.input)!.length).toBeLessThanOrEqual(1_000)
    }

    // Pin the shape assertions to a call that actually has more than one input
    // key, or "keys are preserved" would be satisfied by a single-key object.
    const changedIndex = result.conversation.entries.findIndex((entry, index) => (
      entry.kind === 'tool-call' &&
      entry !== conversation.entries[index] &&
      Object.keys(entry.input as Record<string, unknown>).length >= 2
    ))
    expect(changedIndex).toBeGreaterThanOrEqual(0)
    const trimmedCall = result.conversation.entries[changedIndex]!
    const original = conversation.entries[changedIndex]!
    expect(trimmedCall.kind).toBe('tool-call')
    expect((trimmedCall as { name: string }).name).toBe((original as { name: string }).name)
    // A Claude tool_use input must stay an object with its original keys, or
    // the projector has to repair it and the target loses the edit's schema.
    const trimmedInput = (trimmedCall as { input: unknown }).input as Record<string, unknown>
    const originalInput = (original as { input: unknown }).input as Record<string, unknown>
    expect(Object.keys(trimmedInput).length).toBeGreaterThanOrEqual(2)
    expect(Object.keys(trimmedInput)).toEqual(Object.keys(originalInput))
    expect(JSON.stringify(trimmedInput)).toContain('[tool input trimmed during provider switch:')
    // Short scalar members survive untouched; only the widest string is cut.
    const untouched = Object.keys(originalInput).filter(
      key => JSON.stringify(trimmedInput[key]) === JSON.stringify(originalInput[key]),
    )
    expect(untouched.length).toBeGreaterThan(0)
  })
})

describe('dropOldestTurns', () => {
  it('drops complete user turns from the front and indexes their prompts in the marker', async () => {
    const conversation = await claude('claude-sequence-oversized-turns')
    const before = estimateConversationCharacters(conversation)

    const result = dropOldestTurns(conversation, Math.floor(before * 0.25))

    expect(result.stillExceedsBudget).toBe(false)
    expect(result.droppedTurns).toBeGreaterThan(0)
    expect(result.droppedEntries).toBeGreaterThan(0)
    expect(result.promptIndexLength).toBeGreaterThan(0)
    const marker = result.conversation.entries[0]!
    expect(marker.kind).toBe('compaction')
    expect(marker.kind === 'compaction' ? marker.summarySource : null).toBe('synthetic')
    expect(marker.kind === 'compaction' ? marker.summary : '').toContain('earlier prompts')
    expect(result.conversation.entries[1]?.kind === 'message' && result.conversation.entries[1].role)
      .toBe('user')
    expect(estimateConversationCharacters(result.conversation))
      .toBeLessThanOrEqual(Math.floor(before * 0.25))
  })

  it('retains every developer message that preceded the cut, after the marker', async () => {
    // Census finding 4: Codex developer messages are 36.9 % of this fixture's
    // characters and are the replacement history plus user instructions that
    // survive a remote compaction — in a compacted thread they are the only
    // plaintext left. Dropping them would delete the conversation while
    // reporting that turns were merely trimmed.
    const conversation = await codex('codex-sequence-compacted-multi')
    const before = estimateConversationCharacters(conversation)
    const developers = conversation.entries.filter(isDeveloperMessage)
    expect(developers).toHaveLength(4)

    // 30 % rather than 25 %: below that the marker's own explanatory headline
    // no longer fits alongside the four retained developer messages at this
    // fixture's redacted scale (they are 280 of its 7,636 characters), and the
    // rung correctly reports stillExceedsBudget instead of cutting deeper. The
    // budget is still relative, so it scales with the fixture rather than
    // pinning an absolute number redaction has made meaningless.
    const result = dropOldestTurns(conversation, Math.floor(before * 0.3))

    expect(result.stillExceedsBudget).toBe(false)
    expect(result.droppedTurns).toBeGreaterThan(0)
    expect(result.retainedDeveloperMessages).toBe(4)
    expect(result.conversation.entries[0]?.kind).toBe('compaction')
    expect(estimateConversationCharacters(result.conversation))
      .toBeLessThanOrEqual(Math.floor(before * 0.3))
    const survivors = result.conversation.entries.filter(isDeveloperMessage)
    expect(survivors).toEqual(developers)
    // All four precede the cut at this budget, so all four are lifted out and
    // placed immediately after the marker, in their original relative order...
    expect(result.conversation.entries.slice(1, 5)).toEqual(developers)
    // ...and the marker says so, so the target is not left guessing why four
    // developer messages precede a history that starts later.
    expect(markerSummary(result.conversation))
      .toContain('4 developer messages that preceded the cut are retained immediately below this marker')
  })

  it('drops developer messages with their turns when the caller says the target discards them', async () => {
    // The retention rule is only worth budget if the target persists the role.
    // A Claude target does not (src/claude/project/nativeResume.ts:212-219
    // drops every developer- and system-role message), so charging the budget
    // for them can refuse a switch in order to protect content that would be
    // deleted on arrival. This asserts the two behaviours diverge on exactly
    // the same conversation and the same budget.
    const conversation = await codex('codex-sequence-compacted-multi')
    const budget = Math.floor(estimateConversationCharacters(conversation) * 0.25)

    const dropping = dropOldestTurns(conversation, budget, { keepDeveloperMessages: false })

    expect(dropping.stillExceedsBudget).toBe(false)
    expect(dropping.retainedDeveloperMessages).toBe(0)
    expect(dropping.conversation.entries.filter(isDeveloperMessage)).toHaveLength(0)
    expect(estimateConversationCharacters(dropping.conversation)).toBeLessThanOrEqual(budget)
    // The count is still reported to the target: an unannounced deletion of the
    // only plaintext in a compacted thread is what census finding 4 warns about.
    expect(markerSummary(dropping.conversation))
      .toContain('4 developer messages preceded the cut and were omitted with their turns')

    // Retaining at the same budget cannot fit, which is the whole point.
    const retaining = dropOldestTurns(conversation, budget)
    expect(retaining.stillExceedsBudget).toBe(true)
    expect(() => shrinkConversationToBudget(conversation, budget))
      .toThrow(ConversationUnfittableError)
    expect(shrinkConversationToBudget(conversation, budget, { keepDeveloperMessages: false }).report)
      .toMatchObject({ retainedDeveloperMessages: 0 })
  })
})

describe('shrinkConversationToBudget', () => {
  it('reports each rung it used and lands under budget', async () => {
    const conversation = withCensusToolPayloads(
      await claude('claude-sequence-oversized-turns'),
      CENSUS_OVERSIZED_TURNS_PAYLOADS,
    )
    // A quarter of the estimate stands in for the census population median of
    // 3.55× the budget: clearing every reachable tool result is not enough on
    // its own (census finding 2 — that is true of 46 of 91 real oversized
    // transcripts), so the drop rung must fire too.
    const budget = Math.floor(estimateConversationCharacters(conversation) * 0.25)

    const { conversation: shrunk, report } = shrinkConversationToBudget(conversation, budget)

    expect(estimateConversationCharacters(shrunk)).toBeLessThanOrEqual(budget)
    expect(report.estimatedCharactersAfter).toBeLessThanOrEqual(budget)
    expect(report.estimatedCharactersBefore).toBeGreaterThan(budget)
    expect(report.budgetCharacters).toBe(budget)
    expect(report.clearedResults).toBeGreaterThan(0)
    expect(report.clearedChars).toBeGreaterThan(0)
    expect(report.droppedTurns).toBeGreaterThan(0)
    expect(report.droppedEntries).toBeGreaterThan(0)
    expect(report.promptIndexLength).toBeGreaterThan(0)
    // The fixture's one real compaction is a portable Claude carrier, so the
    // strip rung must leave it alone; only encrypted and rejected carriers go.
    expect(report.strippedCompactions).toBe(0)
  })

  it('fits the committed fixture by dropping turns when redaction leaves nothing to clear', async () => {
    const conversation = await claude('claude-sequence-oversized-turns')
    const budget = Math.floor(estimateConversationCharacters(conversation) * 0.25)

    const { conversation: shrunk, report } = shrinkConversationToBudget(conversation, budget)

    expect(estimateConversationCharacters(shrunk)).toBeLessThanOrEqual(budget)
    // Zero, and correctly so: every redacted output is shorter than the
    // placeholder that would replace it (see fixtureConversations.ts).
    expect(report.clearedResults).toBe(0)
    expect(report.trimmedInputs).toBe(0)
    expect(report.droppedTurns).toBeGreaterThan(0)
  })

  it('throws rather than splitting the single turn a whole transcript consists of', async () => {
    // `claude-sequence-oversized` is 67 entries with exactly ONE user message,
    // at index 0: there is no earlier boundary to drop back to. The real
    // transcript is 1.11× the budget and the census counts it among the 45 of
    // 91 that clearing tool results alone fixes, but at redacted sizes every
    // output is 14 characters and clearing them would only add placeholder
    // text. The honest answer is the error, not a fragment of that turn.
    const conversation = await claude('claude-sequence-oversized')
    const budget = Math.floor(estimateConversationCharacters(conversation) * 0.25)

    let thrown: unknown
    try {
      shrinkConversationToBudget(conversation, budget)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(ConversationUnfittableError)
    expect((thrown as ConversationUnfittableError).report).toMatchObject({
      droppedTurns: 0,
      droppedEntries: 0,
      retainedDeveloperMessages: 0,
      budgetCharacters: budget,
    })
    // Nothing was cut here, so the message must not describe the whole
    // conversation as "the smallest suffix the ladder can produce".
    expect((thrown as Error).message).toContain('no earlier turn boundary to cut back to')
  })

  it('throws instead of emitting a fragment when the last turn alone exceeds the budget', async () => {
    const conversation = await claude('claude-sequence-oversized-turns')
    expect(() => shrinkConversationToBudget(conversation, 200)).toThrow(ConversationUnfittableError)
    // The other error branch: a cut was made and still does not fit.
    expect(() => shrinkConversationToBudget(conversation, 200))
      .toThrow(/the smallest complete suffix the ladder can produce/)
  })

  it('returns the conversation untouched with an all-zero report when it already fits', async () => {
    const conversation = await claude('claude-sequence-oversized')
    const budget = estimateConversationCharacters(conversation)

    const { conversation: shrunk, report } = shrinkConversationToBudget(conversation, budget)

    expect(shrunk).toBe(conversation)
    expect(report).toMatchObject({
      strippedCompactions: 0,
      clearedResults: 0,
      trimmedInputs: 0,
      droppedEntries: 0,
      droppedTurns: 0,
      estimatedCharactersBefore: budget,
      estimatedCharactersAfter: budget,
    })
  })
})

/**
 * A conversation of `turns` complete user/tool-call/tool-result cycles, each
 * carrying a `resultChars`-character tool output. Built here rather than
 * loaded, because the assertion is about the *boundary* between protected and
 * clearable turns and no committed fixture has a controlled turn count at a
 * payload size the clearing rung can act on.
 */
function turnedConversation(turns: number, resultChars: number): ConversationDocument {
  const entries: ConversationEntry[] = []
  const at = (): Pick<ConversationEntry, 'timestamp' | 'source'> => ({
    timestamp: null,
    source: { provider: 'fixture', line: entries.length, raw: {}, evidence: [] },
  })
  for (let turn = 0; turn < turns; turn += 1) {
    entries.push({
      kind: 'message',
      role: 'user',
      content: [{ kind: 'text', text: `prompt ${turn}` }],
      ...at(),
    })
    entries.push({
      kind: 'tool-call',
      callId: `call-${turn}`,
      name: 'Read',
      input: { path: `/fixture/${turn}` },
      nativeKind: 'fixture',
      ...at(),
    })
    entries.push({
      kind: 'tool-result',
      callId: `call-${turn}`,
      output: 'x'.repeat(resultChars),
      isError: false,
      nativeKind: 'fixture',
      ...at(),
    })
  }
  return { schemaVersion: 1, sourceProvider: 'fixture', sourceSessionIds: [], entries }
}

function markerSummary(conversation: { entries: readonly ConversationEntry[] }): string {
  const marker = conversation.entries[0]!
  return marker.kind === 'compaction' ? marker.summary : ''
}

function isToolCall(entry: ConversationEntry): entry is Extract<ConversationEntry, { kind: 'tool-call' }> {
  return entry.kind === 'tool-call'
}

function isDeveloperMessage(entry: ConversationEntry): boolean {
  return entry.kind === 'message' && entry.role === 'developer'
}

function indexesOfUserMessages(entries: readonly ConversationEntry[]): number[] {
  const indexes: number[] = []
  entries.forEach((entry, index) => {
    if (entry.kind === 'message' && entry.role === 'user') indexes.push(index)
  })
  return indexes
}

import { describe, expect, it } from 'vitest'

import type { ConversationEntry } from '../../src/conversation/types.js'
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

    const trimmedCall = result.conversation.entries.find((entry, index) => (
      entry.kind === 'tool-call' && entry !== conversation.entries[index]
    ))
    expect(trimmedCall?.kind).toBe('tool-call')
    const original = conversation.entries[result.conversation.entries.indexOf(trimmedCall!)]!
    expect((trimmedCall as { name: string }).name).toBe((original as { name: string }).name)
    // A Claude tool_use input must stay an object with its original keys, or
    // the projector has to repair it and the target loses the edit's schema.
    const trimmedInput = (trimmedCall as { input: unknown }).input as Record<string, unknown>
    const originalInput = (original as { input: unknown }).input as Record<string, unknown>
    expect(Object.keys(trimmedInput)).toEqual(Object.keys(originalInput))
    expect(JSON.stringify(trimmedInput)).toContain('[tool input trimmed during provider switch:')
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
    expect(result.promptIndexChars).toBeGreaterThan(0)
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
    expect(result.conversation.entries[0]?.kind).toBe('compaction')
    expect(estimateConversationCharacters(result.conversation))
      .toBeLessThanOrEqual(Math.floor(before * 0.3))
    const survivors = result.conversation.entries.filter(isDeveloperMessage)
    expect(survivors).toEqual(developers)
    // Three of the four precede the cut at this budget (the fourth is at entry
    // 94, inside the retained suffix). Those three are lifted out and placed
    // immediately after the marker, in their original relative order...
    expect(result.conversation.entries.slice(1, 4)).toEqual(developers.slice(0, 3))
    // ...and the marker says so, so the target is not left guessing why three
    // developer messages precede a history that starts later.
    expect(result.conversation.entries[0]!.kind === 'compaction'
      ? result.conversation.entries[0]!.summary
      : '').toContain('3 developer messages that preceded the cut are retained')
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
    expect(report.promptIndexChars).toBeGreaterThan(0)
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
      budgetCharacters: budget,
    })
  })

  it('throws instead of emitting a fragment when the last turn alone exceeds the budget', async () => {
    const conversation = await claude('claude-sequence-oversized-turns')
    expect(() => shrinkConversationToBudget(conversation, 200)).toThrow(ConversationUnfittableError)
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

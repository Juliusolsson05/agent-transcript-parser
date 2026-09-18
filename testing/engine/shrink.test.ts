import { describe, expect, it } from 'vitest'

import type { ConversationContent, ConversationDocument, ConversationEntry } from '../../src/conversation/types.js'
import {
  ConversationUnfittableError,
  clearAttachments,
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
  conversationOf,
  image,
  message,
  pastedImageTailConversation,
  toolCall,
  toolResult,
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

describe('clearing rungs are idempotent', () => {
  // The ladder's second pass runs rungs 2 and 4 over entries the first pass
  // already handled. A placeholder or marker must therefore be terminal, or the
  // report counts one loss twice and the text the target reads quotes the
  // length of the previous placeholder instead of the content that vanished.

  it('clearToolResults leaves its own placeholder alone but not an output that merely starts like one', () => {
    const lookalike = `[tool output cleared during provider switch: ${'not a placeholder '.repeat(300)}`
    const conversation = conversationOf([
      message('user', 'one', 0),
      toolCall(1, 'a'),
      toolResult(2, 'a', 'x'.repeat(4_000)),
      toolCall(3, 'b'),
      toolResult(4, 'b', lookalike),
    ])

    const first = clearToolResults(conversation, 1, { keepRecentTurns: 0 })
    const second = clearToolResults(first.conversation, 1, { keepRecentTurns: 0 })

    // Both real outputs go, including the one an agent produced by reading a
    // transcript this ladder had already shrunk.
    expect(first.cleared).toBe(2)
    expect(second).toMatchObject({ cleared: 0, clearedChars: 0 })
    expect(second.conversation).toBe(first.conversation)
    expect(first.conversation.entries[2]).toMatchObject({
      output: '[tool output cleared during provider switch: 4000 characters]',
    })
  })

  it('trimToolInputs leaves its own marker alone when the input still exceeds the cap', () => {
    // 120 characters on purpose. The defect only shows when the marker's quoted
    // number LOSES a digit on the second visit (`120 characters omitted` is a
    // 71-character marker, and re-trimming it writes `71`, one character
    // shorter, which passes the net-savings guard). A two-digit path length
    // re-trims to the same length and hides the bug.
    const filePath = `/fixture/${'d'.repeat(111)}`
    expect(filePath).toHaveLength(120)
    const conversation = conversationOf([
      message('user', 'refactor it', 0),
      toolCall(1, 'multi', {
        file_path: filePath,
        edits: Array.from({ length: 60 }, (_, index) => ({ old_string: `${'o'.repeat(80)}${index}`, new_string: `${'n'.repeat(80)}${index}` })),
      }),
      toolResult(2, 'multi', 'ok'),
    ])

    const first = trimToolInputs(conversation, 1, { keepRecentTurns: 0 })
    const second = trimToolInputs(first.conversation, 1, { keepRecentTurns: 0 })

    expect(first.trimmed).toBe(1)
    expect(second).toMatchObject({ trimmed: 0, trimmedChars: 0 })
    expect(second.conversation).toBe(first.conversation)
    // The marker still quotes what was actually lost, not its own length.
    const input = (first.conversation.entries[1] as { input: Record<string, string> }).input
    expect(input.file_path).toContain(`${filePath.length} characters omitted]`)
  })
})

describe('clearAttachments', () => {
  it('replaces the oldest attachment payloads first and never touches the last three user turns', () => {
    const conversation = attachmentTurns(6, () => image(5_000))
    const before = estimateConversationCharacters(conversation)
    // Room for exactly two clearings: measured, each image item costs 5,104
    // serialized characters and its placeholder 64, so one clearing saves
    // 5,040 and two (10,080) are needed to shed 9,000.
    const budget = before - 9_000

    const result = clearAttachments(conversation, budget)

    expect(result.cleared).toBe(2)
    expect(result.clearedChars).toBeGreaterThan(9_000)
    expect(estimateConversationCharacters(result.conversation)).toBe(before - result.clearedChars)
    expect(estimateConversationCharacters(result.conversation)).toBeLessThanOrEqual(budget)
    // The placeholder takes the attachment's place, so the prompt text and its
    // position relative to the attachment survive.
    expect(result.conversation.entries[0]).toMatchObject({
      kind: 'message',
      role: 'user',
      content: [
        { kind: 'text', text: 'turn 0' },
        { kind: 'text', text: '[image omitted during provider switch]' },
      ],
    })
    expect(result.conversation.entries[2]).toMatchObject({
      content: [{ kind: 'text', text: 'turn 1' }, { kind: 'text', text: '[image omitted during provider switch]' }],
    })
    // Turn 2 was reachable but not needed; turns 3-5 are protected. All four
    // keep their original entry objects.
    for (let index = 4; index < conversation.entries.length; index += 1) {
      expect(result.conversation.entries[index]).toBe(conversation.entries[index])
    }
  })

  it('honours the protection even when clearing everything reachable is not enough', () => {
    const conversation = attachmentTurns(6, () => image(5_000))

    const result = clearAttachments(conversation, 100)

    // Three reachable images gone, three protected ones intact, still over.
    expect(result.cleared).toBe(3)
    const protectedFrom = indexesOfUserMessages(conversation.entries).at(-3)!
    for (let index = protectedFrom; index < conversation.entries.length; index += 1) {
      expect(result.conversation.entries[index]).toBe(conversation.entries[index])
    }
    expect(estimateConversationCharacters(result.conversation)).toBeGreaterThan(100)
  })

  it('treats documents and unknown non-text blocks as attachments and leaves text-only messages alone', () => {
    const conversation = attachmentTurns(6, turn => {
      if (turn === 0) return { kind: 'text', text: 'x'.repeat(3_000) }
      if (turn === 1) {
        return {
          kind: 'document',
          value: { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'P'.repeat(3_000) } },
        }
      }
      return { kind: 'opaque', nativeType: 'file', value: { type: 'file', mime: 'image/png', url: `data:image/png;base64,${'F'.repeat(3_000)}` } }
    })

    const result = clearAttachments(conversation, 0)

    // Turn 0's 3,000 characters of prose are the user's own words: not an
    // attachment, not this rung's business, however over budget we are.
    expect(result.conversation.entries[0]).toBe(conversation.entries[0])
    expect(result.conversation.entries[2]).toMatchObject({
      content: [{ kind: 'text', text: 'turn 1' }, { kind: 'text', text: '[document omitted during provider switch]' }],
    })
    expect(result.conversation.entries[4]).toMatchObject({
      content: [{ kind: 'text', text: 'turn 2' }, { kind: 'text', text: '[attachment omitted during provider switch]' }],
    })
    expect(result.cleared).toBe(2)
  })

  it('never grows a message whose attachment is shorter than the placeholder', () => {
    const conversation = attachmentTurns(6, () => ({ kind: 'opaque', nativeType: 'x', value: { type: 'x' } }))

    const result = clearAttachments(conversation, 0)

    expect(result).toMatchObject({ cleared: 0, clearedChars: 0 })
    expect(result.conversation).toBe(conversation)
  })

  it('returns the conversation untouched when it already fits', () => {
    const conversation = attachmentTurns(6, () => image(5_000))
    const result = clearAttachments(conversation, estimateConversationCharacters(conversation))
    expect(result.conversation).toBe(conversation)
    expect(result.cleared).toBe(0)
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

  it('fits the recorded shape whose newest turn is a tiny prompt plus a pasted image (#28)', () => {
    // See pastedImageTailConversation for the real transcript this mirrors.
    // Before the attachment rung and the protection lift, this threw
    // "the smallest complete suffix the ladder can produce is N characters"
    // after dropping every earlier turn: the newest turn was 99.98 % one image
    // and no rung read message content.
    const conversation = pastedImageTailConversation()
    const budget = 3_000
    expect(estimateConversationCharacters(conversation)).toBeGreaterThan(budget * 15)

    const { conversation: shrunk, report } = shrinkConversationToBudget(conversation, budget)

    expect(estimateConversationCharacters(shrunk)).toBeLessThanOrEqual(budget)
    expect(report.estimatedCharactersAfter).toBeLessThanOrEqual(budget)
    // Both attachments went: the opaque OpenCode part two turns back and the
    // pasted image in the newest turn. The latter sits inside the protected
    // turns, which is why the lift is reported.
    expect(report.clearedAttachments).toBe(2)
    expect(report.clearedAttachmentChars).toBeGreaterThan(50_000)
    expect(report.liftedRecentTurnProtection).toBe(true)
    // Clearing alone is still not enough at this budget, so the drop rung fired
    // too — the real transcript's proportion.
    expect(report.droppedTurns).toBeGreaterThan(0)
    // ...but it took only what was still necessary. The lift runs on the
    // conversation as it stood BEFORE the failed drop, so turns that fit once
    // the recent payload is gone are kept. A lift that re-ran on the fallback
    // cut (the last turn alone) would lose `prompt 4` and everything before it
    // while satisfying every other assertion here.
    expect(report.droppedTurns).toBeLessThan(5)
    expect(shrunk.entries).toContainEqual(expect.objectContaining({
      kind: 'message',
      role: 'user',
      content: [{ kind: 'text', text: 'prompt 4' }],
    }))
    // Never a fragment: the retained history opens on the marker and then a
    // complete user turn.
    expect(shrunk.entries[0]?.kind).toBe('compaction')
    expect(shrunk.entries[1]).toMatchObject({ kind: 'message', role: 'user' })
    // The newest user turn survives with its words and a placeholder where the
    // image was, so the target knows the user showed something here.
    const newestUser = [...shrunk.entries].reverse().find(entry => entry.kind === 'message' && entry.role === 'user')
    expect(newestUser).toMatchObject({
      content: [
        { kind: 'text', text: 'This [Image #1]' },
        { kind: 'text', text: '[image omitted during provider switch]' },
      ],
    })
  })

  it('reclaims tool output inside the newest turn instead of refusing the switch', () => {
    // The same failure without any image: a final turn whose one tool output is
    // itself larger than the budget. Protection kept rung 2 off it and the
    // fallback "kept the last complete turn whole" — which is the turn that
    // did not fit.
    const entries = turnedConversation(3, 200).entries
    const line = (): number => entries.length
    entries.push(message('user', 'run it', line()))
    entries.push(toolCall(line(), 'call-final', { command: 'cat big.log' }))
    entries.push(toolResult(line(), 'call-final', 'log line '.repeat(2_500)))
    entries.push(message('assistant', 'Looked at the log.', line()))
    const conversation = conversationOf(entries)

    const { conversation: shrunk, report } = shrinkConversationToBudget(conversation, 3_000)

    expect(estimateConversationCharacters(shrunk)).toBeLessThanOrEqual(3_000)
    expect(report.liftedRecentTurnProtection).toBe(true)
    expect(report.clearedResults).toBeGreaterThanOrEqual(1)
    const finalResult = [...shrunk.entries].reverse().find(entry => entry.kind === 'tool-result')
    expect(finalResult).toMatchObject({
      callId: 'call-final',
      output: expect.stringContaining('[tool output cleared during provider switch:'),
    })
    expect(shrunk.entries.find(entry => entry.kind !== 'compaction')).toMatchObject({ kind: 'message', role: 'user' })
  })

  it('lifts the protection with the cheapest rungs that keep the same history', () => {
    // Review finding on the first version of the lift: it ran rungs 2→3→4
    // unconditionally, and because each rung stops only when the WHOLE
    // conversation fits, rung 2 cleared every recent tool output on its way to
    // the pasted image that was the actual cause — for no additional retained
    // history. Scaled from the reviewer's input (549k image, 20k outputs,
    // 288,000 budget).
    const entries: ConversationEntry[] = []
    const line = (): number => entries.length
    for (let turn = 0; turn < 5; turn += 1) {
      entries.push(message('user', `old ${turn}`, line()))
      entries.push(message('assistant', 'w'.repeat(10_000), line()))
    }
    for (let turn = 0; turn < 2; turn += 1) {
      entries.push(message('user', `recent ${turn}`, line()))
      entries.push(toolCall(line(), `recent-${turn}`))
      entries.push(toolResult(line(), `recent-${turn}`, 'o'.repeat(2_000)))
      entries.push(message('assistant', 'ok', line()))
    }
    entries.push(message('user', [{ kind: 'text', text: 'This [Image #1]' }, image(55_000)], line()))
    entries.push(toolCall(line(), 'newest'))
    entries.push(toolResult(line(), 'newest', 'o'.repeat(2_000)))
    entries.push(message('assistant', 'I see it', line()))
    const conversation = conversationOf(entries)

    const { conversation: shrunk, report } = shrinkConversationToBudget(conversation, 28_800)

    expect(estimateConversationCharacters(shrunk)).toBeLessThanOrEqual(28_800)
    expect(report).toMatchObject({
      clearedAttachments: 1,
      clearedResults: 0,
      liftedRecentTurnProtection: true,
    })
    // All three recent outputs are intact: they are what the protection is for.
    expect(shrunk.entries.filter(entry => entry.kind === 'tool-result').map(entry => entry.output))
      .toEqual(['o'.repeat(2_000), 'o'.repeat(2_000), 'o'.repeat(2_000)])
    // ...and no history was traded for them: the full lift keeps the same turns.
    const everything = shrinkConversationToBudget(
      conversationOf(entries.map(entry => (entry.kind === 'tool-result' ? { ...entry, output: 'x' } : entry))),
      28_800,
    )
    expect(report.droppedTurns).toBe(everything.report.droppedTurns)
  })

  it('never counts the same removal twice when the protection is lifted', () => {
    // A tool input whose bulk is NESTED can never get under the cap, so the
    // first pass truncates its string member to the bare marker and the second
    // pass visits it again. Before the marker was made terminal this reported
    // `trimmedInputs: 2` for one call, rewrote the marker to quote the length of
    // the previous MARKER, and set `liftedRecentTurnProtection` on a switch
    // where nothing real was removed — the newest turn here is the user's own
    // prose, which no rung may take.
    const entries: ConversationEntry[] = [
      message('user', 'refactor it', 0),
      toolCall(1, 'nested', {
        prompt: 'p'.repeat(30_000),
        context: Array.from({ length: 400 }, (_, index) => ({ id: index, note: 'small object' })),
      }),
      toolResult(2, 'nested', 'ok'),
      message('assistant', 'done', 3),
      message('user', 'two', 4),
      message('assistant', 'a', 5),
      message('user', 'three', 6),
      message('assistant', 'b', 7),
      message('user', 'my own words '.repeat(3_000), 8),
    ]

    let thrown: unknown
    try {
      shrinkConversationToBudget(conversationOf(entries), 20_000)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(ConversationUnfittableError)
    expect((thrown as ConversationUnfittableError).report).toMatchObject({
      trimmedInputs: 1,
      liftedRecentTurnProtection: false,
    })
  })

  it('leaves the protected turns alone whenever dropping older turns is enough', () => {
    // The lift is a last resort, not a shortcut: when the suffix of protected
    // turns fits on its own, the ladder must still prefer losing old history
    // over touching recent payload, exactly as before.
    const conversation = turnedConversation(6, 2_000)
    const userIndexes = indexesOfUserMessages(conversation.entries)
    const protectedFrom = userIndexes.at(-3)!
    const protectedCost = conversation.entries
      .slice(protectedFrom)
      .reduce((sum, entry) => sum + estimateConversationCharacters(conversationOf([entry])), 0)
    const budget = protectedCost + 400

    const { conversation: shrunk, report } = shrinkConversationToBudget(conversation, budget)

    expect(report.liftedRecentTurnProtection).toBe(false)
    // Rung 2 clears the three old outputs first, so fewer than three turns need
    // to go; the exact count is the marker's arithmetic, not the contract here.
    expect(report.droppedTurns).toBeGreaterThan(0)
    expect(report.droppedTurns).toBeLessThanOrEqual(3)
    const protectedEntries = conversation.entries.slice(protectedFrom)
    expect(shrunk.entries.slice(-protectedEntries.length)).toEqual(protectedEntries)
  })

  it("still throws when the newest turn's own text exceeds the budget", () => {
    // Nothing here is payload the ladder may remove: the user wrote it. The
    // lift finds nothing to clear, the drop rung cannot fit the turn, and the
    // honest answer is still the error — never a fragment of the prompt.
    const entries = turnedConversation(2, 100).entries
    entries.push(message('user', 'a very long prompt '.repeat(600), entries.length))
    entries.push(message('assistant', 'ok', entries.length))
    const conversation = conversationOf(entries)

    let thrown: unknown
    try {
      shrinkConversationToBudget(conversation, 1_000)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(ConversationUnfittableError)
    expect((thrown as Error).message).toContain('the smallest complete suffix the ladder can produce')
    expect((thrown as ConversationUnfittableError).report).toMatchObject({
      clearedAttachments: 0,
      liftedRecentTurnProtection: false,
    })
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
  for (let turn = 0; turn < turns; turn += 1) {
    entries.push(message('user', `prompt ${turn}`, entries.length))
    entries.push(toolCall(entries.length, `call-${turn}`, { path: `/fixture/${turn}` }))
    entries.push(toolResult(entries.length, `call-${turn}`, 'x'.repeat(resultChars)))
  }
  return conversationOf(entries)
}

/**
 * `turns` user/assistant pairs where each user message is `turn N` plus one
 * extra content item chosen by `extra(turn)` — the shape the attachment rung
 * acts on, with a controlled turn count so the protected boundary is exact.
 */
function attachmentTurns(
  turns: number,
  extra: (turn: number) => ConversationContent,
): ConversationDocument {
  const entries: ConversationEntry[] = []
  for (let turn = 0; turn < turns; turn += 1) {
    entries.push(message('user', [{ kind: 'text', text: `turn ${turn}` }, extra(turn)], entries.length))
    entries.push(message('assistant', `reply ${turn}`, entries.length))
  }
  return conversationOf(entries)
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

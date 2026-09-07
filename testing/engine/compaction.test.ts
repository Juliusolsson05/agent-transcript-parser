import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  classifyClaudeDocument,
  conversationAfterLatestPortableCompaction,
  decodeClaudeConversation,
  decodeJsonl,
  describeLatestCompaction,
  findApiErrorAfterLine,
} from '../../src/index.js'
import type { ConversationCompaction, ConversationDocument, ConversationEntry } from '../../src/conversation/types.js'

const fixture = new URL('../../fixtures/evidence/observed-sequences/claude-sequence-rate-limit/source.jsonl', import.meta.url)

async function loadRateLimitConversation() {
  const raw = decodeJsonl(await readFile(fixture, 'utf8'))
  return decodeClaudeConversation(classifyClaudeDocument(raw).records)
}

/**
 * The real Claude rate-limit message, quoted verbatim from the Stage 0 census
 * (`docs/decomposition/evidence/provider-switch/census.md`), placeholders and
 * all. The census measured it at 154-157 characters and identical across all
 * seven local rate-limit transcripts apart from the reset time. It is a product
 * template rendered by Claude Code, not user content, which is why it can be
 * quoted here.
 *
 * WHY it is not read out of the fixture: the observed-sequence redactor
 * replaces every private scalar with the literal `fixture text`, so the
 * committed record's own message text is `"fixture text"`. A carrier
 * synthesized from that string would not contain a rate-limit prefix and the
 * rejection tests would pass or fail for reasons unrelated to #820. The fixture
 * still supplies the entry's real coordinates (line, timestamp, raw record);
 * only the text is synthesized-from-real.
 */
const OBSERVED_RATE_LIMIT_MESSAGE =
  "You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message · your session limit resets <time> (<timezone>)"

/**
 * The preamble `getCompactUserSummaryMessage` prepends to every persisted
 * Claude carrier (vendor/claude-code-src/full/services/compact/prompt.ts:337-346),
 * quoted verbatim. Every carrier-writing site goes through it, and the census
 * confirms the one real post-limit carrier in the corpus opens with it. This is
 * the reason the guard cannot be a `startsWith` on the carrier text.
 */
const CLAUDE_CONTINUATION_PREAMBLE =
  'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.'

/** The carrier Claude actually writes to disk when it accepts a summary. */
function persistedCarrierText(summary: string): string {
  return `${CLAUDE_CONTINUATION_PREAMBLE}\n\nSummary:\n${summary}`
}

/**
 * Build a one-carrier document anchored to the fixture's real API-error entry:
 * the carrier inherits that record's timestamp and source coordinates and sits
 * on the next line, which is where Claude would have written it.
 */
function carrierDocument(
  conversation: ConversationDocument,
  options: {
    summary: string
    source?: ConversationCompaction['source']
    precedingEntries?: ConversationEntry[]
  },
): ConversationDocument {
  const error = findApiErrorAfterLine(conversation, -1)!
  const carrier: ConversationCompaction = {
    kind: 'compaction',
    summary: options.summary,
    summarySource: 'carrier',
    timestamp: error.timestamp,
    source: options.source ?? { ...error.source, line: error.source.line + 1 },
  }
  return { ...conversation, entries: [...options.precedingEntries ?? [], carrier] }
}

describe('rate-limit records', () => {
  it('decodes a Claude rate-limit API error as an opaque entry, never as assistant text', async () => {
    const conversation = await loadRateLimitConversation()
    const errors = conversation.entries.filter(entry => entry.kind === 'opaque' && entry.nativeType === 'api_error')
    expect(errors.length).toBeGreaterThan(0)
    const assistantText = conversation.entries
      .filter(entry => entry.kind === 'message' && entry.role === 'assistant')
      .flatMap(entry => entry.kind === 'message' ? entry.content : [])
      .filter(content => content.kind === 'text')
      .map(content => content.kind === 'text' ? content.text : '')
    expect(assistantText.some(text => text.startsWith("You've hit your"))).toBe(false)
    // WHY this second, structural assertion exists: on redacted fixture data
    // the prefix check above is vacuous (every text is `fixture text`), so it
    // cannot detect the regression it names. The record's `isApiErrorMessage`
    // flag survives redaction, so assert directly that no message entry is
    // sourced from an API-error record.
    const messagesFromApiErrors = conversation.entries.filter(
      entry => entry.kind === 'message' && entry.source.raw.isApiErrorMessage === true,
    )
    expect(messagesFromApiErrors).toHaveLength(0)
  })

  it('moves exactly one fixture record from assistant message to opaque and leaves the rest alone', async () => {
    const conversation = await loadRateLimitConversation()
    const counts = conversation.entries.reduce<Record<string, number>>((totals, entry) => {
      const key = entry.kind === 'message' ? `message/${entry.role}` : entry.kind
      totals[key] = (totals[key] ?? 0) + 1
      return totals
    }, {})
    // WHY the whole distribution is pinned rather than just the api_error
    // count: this records the exact blast radius of the decode change on the
    // 71-record fixture. Before it, the same file decoded to 1 opaque (the
    // `isMeta` user record, nativeType "user") and 2 assistant messages; the
    // limit record moved from the second bucket to the first and nothing else
    // shifted. A future decode rule that quietly reclassifies tool cycles or
    // reasoning will fail here instead of silently changing what gets projected.
    expect(conversation.entries).toHaveLength(71)
    expect(counts).toEqual({
      'message/user': 1,
      'message/assistant': 1,
      reasoning: 7,
      'tool-call': 30,
      'tool-result': 30,
      opaque: 2,
    })
    const opaqueTypes = conversation.entries
      .filter(entry => entry.kind === 'opaque')
      .map(entry => entry.kind === 'opaque' ? entry.nativeType : null)
    expect(opaqueTypes).toEqual(['user', 'api_error'])
  })

  it('reports the first API error after a baseline line', async () => {
    const conversation = await loadRateLimitConversation()
    const found = findApiErrorAfterLine(conversation, -1)
    expect(found?.kind).toBe('opaque')
    expect(findApiErrorAfterLine(conversation, found!.source.line)).toBeNull()
  })

  it('rejects a compaction carrier whose text is a rate-limit message', async () => {
    const conversation = await loadRateLimitConversation()

    // The shape Claude actually persists: the limit message sits ~150
    // characters in, behind the continuation preamble and a "Summary:" header.
    // A `startsWith` guard on the carrier misses precisely this case.
    const persisted = carrierDocument(conversation, {
      summary: persistedCarrierText(OBSERVED_RATE_LIMIT_MESSAGE),
    })
    expect(describeLatestCompaction(persisted)?.availability).toBe('rejected')

    // The bare shape stays covered too: a producer that stores the summary
    // without the wrapper must be rejected on the same evidence.
    const bare = carrierDocument(conversation, { summary: OBSERVED_RATE_LIMIT_MESSAGE })
    expect(describeLatestCompaction(bare)?.availability).toBe('rejected')
  })

  it('keeps every pre-compaction entry when the carrier is rejected', async () => {
    const conversation = await loadRateLimitConversation()
    const precedingEntries = conversation.entries.slice(0, 10)
    const document = carrierDocument(conversation, {
      summary: persistedCarrierText(OBSERVED_RATE_LIMIT_MESSAGE),
      precedingEntries,
    })

    // WHY this is the assertion that matters for #820: rejection is only
    // useful if it stops the summary from replacing history. A `portable`
    // verdict here would slice everything before the carrier away and the
    // switch would ship a transcript containing nothing but a billing notice.
    const kept = conversationAfterLatestPortableCompaction(document)
    expect(kept.entries).toEqual(document.entries)
    expect(kept.entries).toHaveLength(precedingEntries.length + 1)

    // The control that makes the assertion above non-vacuous: the identical
    // document with a real summary IS collapsed to the carrier, so the ten
    // surviving entries are the rejection doing work, not the helper being a
    // no-op.
    const accepted = carrierDocument(conversation, {
      summary: persistedCarrierText('The user asked for a parser hazard fix and we wrote the tests first.'),
      precedingEntries,
    })
    expect(conversationAfterLatestPortableCompaction(accepted).entries).toHaveLength(1)
  })

  it('still accepts a genuine Claude summary and a non-Claude plaintext carrier', async () => {
    const conversation = await loadRateLimitConversation()
    const genuine = carrierDocument(conversation, {
      summary: persistedCarrierText('The user asked for a parser hazard fix and we wrote three tests.'),
    })
    expect(describeLatestCompaction(genuine)?.availability).toBe('portable')

    // WHY a Codex carrier is exempt: CLAUDE_RATE_LIMIT_PREFIXES is Claude
    // Code's own list, and the line-start match is wide enough that a Codex or
    // OpenCode summary narrating "You've used the Bash tool ..." would
    // otherwise be discarded for words no other provider writes as a limit
    // notice.
    const codex = carrierDocument(conversation, {
      summary: `Recap of the session.\n${OBSERVED_RATE_LIMIT_MESSAGE}`,
      source: {
        provider: 'codex',
        line: 12,
        raw: { type: 'compacted' },
        evidence: [],
      },
    })
    expect(describeLatestCompaction(codex)?.availability).toBe('portable')
  })
})

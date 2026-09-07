import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  classifyClaudeDocument,
  decodeClaudeConversation,
  decodeJsonl,
  describeLatestCompaction,
  findApiErrorAfterLine,
} from '../../src/index.js'

const fixture = new URL('../../fixtures/evidence/observed-sequences/claude-sequence-rate-limit/source.jsonl', import.meta.url)

async function loadRateLimitConversation() {
  const raw = decodeJsonl(await readFile(fixture, 'utf8'))
  return decodeClaudeConversation(classifyClaudeDocument(raw).records)
}

/**
 * The real Claude rate-limit message, as recorded by the Stage 0 census
 * (`docs/decomposition/evidence/provider-switch/census.md`). It is a product
 * template rendered by Claude Code, not user content, which is why it can be
 * quoted here verbatim.
 *
 * WHY it is not read out of the fixture: the observed-sequence redactor
 * replaces every private scalar with the literal `fixture text`, so the
 * committed record's own message text is `"fixture text"`. A carrier
 * synthesized from that string would not start with a rate-limit prefix and
 * the rejection test would pass or fail for reasons unrelated to #820. The
 * fixture still supplies the entry's real coordinates (line, timestamp, raw
 * record); only the text is synthesized-from-real.
 */
const OBSERVED_RATE_LIMIT_MESSAGE =
  "You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message · your session limit resets 3pm (Europe/Stockholm)"

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

  it('reports the first API error after a baseline line', async () => {
    const conversation = await loadRateLimitConversation()
    const found = findApiErrorAfterLine(conversation, -1)
    expect(found?.kind).toBe('opaque')
    expect(findApiErrorAfterLine(conversation, found!.source.line)).toBeNull()
  })

  it('rejects a compaction carrier whose text is a rate-limit message', async () => {
    const conversation = await loadRateLimitConversation()
    const error = findApiErrorAfterLine(conversation, -1)!
    // Synthesized from the real record's coordinates plus the observed
    // rate-limit template: the boundary + carrier pair Claude would write if it
    // accepted this text as its summary (see #820).
    const synthetic = {
      ...conversation,
      entries: [{
        kind: 'compaction' as const,
        summary: OBSERVED_RATE_LIMIT_MESSAGE,
        summarySource: 'carrier' as const,
        timestamp: error.timestamp,
        source: { ...error.source, line: error.source.line + 1 },
      }],
    }
    expect(describeLatestCompaction(synthetic)?.availability).toBe('rejected')
  })
})

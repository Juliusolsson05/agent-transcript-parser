import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import { classifyClaudeDocument } from '../../src/claude/classify/classify.js'
import { decodeClaudeConversation } from '../../src/claude/conversation/decode.js'
import { classifyCodexDocument } from '../../src/codex/classify/classify.js'
import { decodeCodexConversation } from '../../src/codex/conversation/decode.js'
import { decodeJsonl } from '../../src/jsonl/codec.js'

const sequences = new URL('../../fixtures/evidence/observed-sequences/', import.meta.url)

describe('provider-neutral conversation decoding from observed sequences', () => {
  it('preserves Claude tool identity across the semantic boundary', async () => {
    const source = await fixture('claude-sequence-tool-cycle')
    const conversation = decodeClaudeConversation(classifyClaudeDocument(decodeJsonl(source)).records)
    const call = conversation.entries.find(entry => entry.kind === 'tool-call')
    const result = conversation.entries.find(entry => entry.kind === 'tool-result')
    expect(call?.kind).toBe('tool-call')
    expect(result?.kind).toBe('tool-result')
    if (call?.kind === 'tool-call' && result?.kind === 'tool-result') {
      expect(call.callId).toBe(result.callId)
    }
  })

  it('does not duplicate Codex user prompts from event and response planes', async () => {
    const source = await fixture('codex-sequence-prompts')
    const conversation = decodeCodexConversation(classifyCodexDocument(decodeJsonl(source)).records)
    expect(conversation.entries.filter(entry => entry.kind === 'message' && entry.role === 'user')).toHaveLength(3)
    expect(conversation.entries.filter(entry => entry.kind === 'opaque')).toHaveLength(4)
  })
})

function fixture(caseId: string): Promise<string> {
  return readFile(new URL(`${caseId}/source.jsonl`, sequences), 'utf8')
}

import { describe, expect, it } from 'vitest'

import { analyzeClaudeTranscript } from '../../src/claude/analyze/analyze.js'
import { classifyClaudeRecord } from '../../src/claude/classify/classify.js'
import { decodeClaudeConversation } from '../../src/claude/conversation/decode.js'
import { classifyCodexRecord } from '../../src/codex/classify/classify.js'

describe('provider classification', () => {
  it('keeps an unknown Claude record opaque', () => {
    const result = classifyClaudeRecord({ type: 'future-provider-shape', secret: 'kept raw' })
    expect(result.family).toBe('opaque')
    expect(result.raw).toEqual({ type: 'future-provider-shape', secret: 'kept raw' })
    expect(result.diagnostics).toEqual(['Uncatalogued Claude record type.'])
  })

  it('distinguishes source-backed Codex records from observed extensions', () => {
    const native = classifyCodexRecord({ type: 'session_meta', payload: { id: 'fixture' } })
    const extension = classifyCodexRecord({ type: 'atp_passthrough', payload: {} })

    expect(native.family).toBe('session-meta')
    expect(native.evidence.map(value => value.provenance)).toContain('pinned-upstream-source')
    expect(extension.family).toBe('observed-extension')
    expect(extension.evidence.map(value => value.provenance)).not.toContain('pinned-upstream-source')
  })

  it('reports structural mismatch instead of repairing it', () => {
    const result = classifyClaudeRecord({
      type: 'assistant',
      message: { role: 'user', content: 'text' },
    })

    expect(result.family).toBe('assistant-message')
    expect(result.diagnostics).toContain('Top-level type assistant does not match message role user.')
  })

  it('keeps Claude meta prompts out of durable conversation semantics', () => {
    const record = classifyClaudeRecord({
      type: 'user',
      isMeta: true,
      message: { role: 'user', content: [{ type: 'text', text: 'hidden provider instruction' }] },
    }, 3)

    expect(analyzeClaudeTranscript([record]).prompts).toEqual([])
    expect(decodeClaudeConversation([record]).entries).toEqual([
      expect.objectContaining({ kind: 'opaque', source: expect.objectContaining({ line: 3 }) }),
    ])
  })

  it('does not offer a malformed text block that the decoder cannot resolve', () => {
    const record = classifyClaudeRecord({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text' }] },
    }, 4)

    expect(analyzeClaudeTranscript([record]).prompts).toEqual([])
    expect(decodeClaudeConversation([record]).entries).toEqual([])
  })
})

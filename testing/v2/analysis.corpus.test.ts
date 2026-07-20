import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import { analyzeClaudeTranscript } from '../../src/v2/claude/analyze/analyze.js'
import { classifyClaudeDocument } from '../../src/v2/claude/classify/classify.js'
import { analyzeCodexTranscript } from '../../src/v2/codex/analyze/analyze.js'
import { classifyCodexDocument } from '../../src/v2/codex/classify/classify.js'
import { decodeJsonl } from '../../src/v2/jsonl/codec.js'

const sequences = new URL('../../fixtures/v2/observed-sequences/', import.meta.url)

describe('v2 graph analysis over observed sequences', () => {
  it('pairs a real Claude tool cycle and retains provider-native prompt addresses', async () => {
    const analysis = await analyzeClaude('claude-sequence-tool-cycle')
    expect(analysis.toolPairs).toHaveLength(1)
    expect(analysis.prompts).toHaveLength(1)
    expect(analysis.prompts[0]?.address.provider).toBe('claude')
    expect(analysis.diagnostics.map(value => value.code)).not.toContain('unmatched-tool-call')
  })

  it('pairs a real Claude compact boundary with its summary', async () => {
    const analysis = await analyzeClaude('claude-sequence-compaction')
    expect(analysis.compactions).toHaveLength(1)
    expect(analysis.compactions[0]?.summaryLine).not.toBeNull()
  })

  it('enumerates only response-item user prompts in a rollout with duplicate event messages', async () => {
    const analysis = await analyzeCodex('codex-sequence-prompts')
    expect(analysis.prompts).toHaveLength(3)
    expect(analysis.prompts.map(value => value.address.line)).toEqual([2, 4, 6])
  })

  it('pairs real Codex calls and reports real rollback mutations', async () => {
    const tools = await analyzeCodex('codex-sequence-tool-cycle')
    const rollback = await analyzeCodex('codex-sequence-rollback')
    expect(tools.toolPairs).toHaveLength(1)
    expect(rollback.diagnostics.map(value => value.code)).toContain('history-rollback')
  })
})

async function analyzeClaude(caseId: string) {
  const source = await readFile(new URL(`${caseId}/source.jsonl`, sequences), 'utf8')
  return analyzeClaudeTranscript(classifyClaudeDocument(decodeJsonl(source)).records)
}

async function analyzeCodex(caseId: string) {
  const source = await readFile(new URL(`${caseId}/source.jsonl`, sequences), 'utf8')
  return analyzeCodexTranscript(classifyCodexDocument(decodeJsonl(source)).records)
}

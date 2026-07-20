import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import { classifyClaudeDocument, classifyClaudeRecord } from '../../src/claude/classify/index.js'
import {
  claudeConversationDecoder,
  decodeClaudeConversation,
} from '../../src/claude/conversation/index.js'
import { projectClaudeArchive } from '../../src/claude/project/index.js'
import { classifyCodexDocument, classifyCodexRecord } from '../../src/codex/classify/index.js'
import { decodeCodexConversation } from '../../src/codex/conversation/decode.js'
import { codexArchiveProjector, projectCodexArchive } from '../../src/codex/project/index.js'
import { decodeJsonl } from '../../src/jsonl/codec.js'
import { translateArchive } from '../../src/translation/archive.js'

const sequences = new URL('../../fixtures/evidence/observed-sequences/', import.meta.url)
const options = {
  targetSessionId: 'fixture-target-session',
  now: '2026-07-20T12:00:00.000Z',
}

describe('archive projection over observed provider sequences', () => {
  it('carries a real Claude tool cycle through neutral form into Codex', async () => {
    const source = await fixture('claude-sequence-tool-cycle')
    const classified = classifyClaudeDocument(decodeJsonl(source)).records
    const archive = translateArchive(
      claudeConversationDecoder,
      codexArchiveProjector,
      classified,
      options,
    )
    const decoded = decodeCodexConversation(archive.values.map(classifyCodexRecord))

    const call = decoded.entries.find(entry => entry.kind === 'tool-call')
    const result = decoded.entries.find(entry => entry.kind === 'tool-result')
    expect(call?.kind).toBe('tool-call')
    expect(result?.kind).toBe('tool-result')
    if (call?.kind === 'tool-call' && result?.kind === 'tool-result') {
      expect(call.callId).toBe(result.callId)
      expect(call.name).toBe('FixtureName')
    }
    expect(archive.report.counts.dropped).toBe(0)
  })

  it('carries a real Codex tool cycle through neutral form into Claude', async () => {
    const source = await fixture('codex-sequence-tool-cycle')
    const neutral = decodeCodexConversation(classifyCodexDocument(decodeJsonl(source)).records)
    const archive = projectClaudeArchive(neutral, options)
    const decoded = decodeClaudeConversation(archive.values.map(classifyClaudeRecord))

    const call = decoded.entries.find(entry => entry.kind === 'tool-call')
    const result = decoded.entries.find(entry => entry.kind === 'tool-result')
    expect(call?.kind).toBe('tool-call')
    expect(result?.kind).toBe('tool-result')
    if (call?.kind === 'tool-call' && result?.kind === 'tool-result') {
      expect(call.callId).toBe(result.callId)
      expect(call.name).toBe('FixtureName')
    }
    expect(archive.report.counts.dropped).toBe(0)
  })

  it('preserves every same-provider observed Codex record before retargeting identity', async () => {
    const source = await fixture('codex-sequence-prompts')
    const document = decodeJsonl(source)
    const neutral = decodeCodexConversation(classifyCodexDocument(document).records)
    const archive = projectCodexArchive(neutral, options)
    const sourceValues = document.lines
      .filter(line => line.kind === 'record')
      .map(line => line.kind === 'record' ? line.value : null)

    expect(archive.values).toHaveLength(sourceValues.length)
    expect(archive.values.slice(1)).toEqual(sourceValues.slice(1))
    expect(archive.values[0]).toMatchObject({
      type: 'session_meta',
      payload: { id: options.targetSessionId },
    })
  })

  it('preserves every same-provider observed Claude record before retargeting identity', async () => {
    const source = await fixture('claude-sequence-tool-cycle')
    const document = decodeJsonl(source)
    const neutral = decodeClaudeConversation(classifyClaudeDocument(document).records)
    const archive = projectClaudeArchive(neutral, options)
    const sourceValues = document.lines
      .filter(line => line.kind === 'record')
      .map(line => line.kind === 'record' ? line.value : null)

    expect(archive.values).toHaveLength(sourceValues.length)
    for (const [index, value] of archive.values.entries()) {
      expect(value).toEqual({
        ...(sourceValues[index] as Record<string, unknown>),
        sessionId: options.targetSessionId,
      })
    }
  })
})

function fixture(caseId: string): Promise<string> {
  return readFile(new URL(`${caseId}/source.jsonl`, sequences), 'utf8')
}

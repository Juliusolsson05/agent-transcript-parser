import { describe, expect, it } from 'vitest'

import {
  analyzeClaudeTranscript,
  analyzeCodexTranscript,
  classifyClaudeDocument,
  classifyCodexDocument,
  claudeArchiveProjector,
  claudeNativeResumeProjector,
  codexArchiveProjector,
  codexNativeResumeProjector,
  decodeClaudeConversation,
  decodeCodexConversation,
  decodeJsonl,
} from '../../src/index.js'

const marker = {
  origin: 'ghost',
  turnId: 'provisional-turn',
  blockIndex: 0,
  createdAt: 100,
  updatedAt: 110,
}

describe('frozen ghost boundary', () => {
  it('does not promote or project a Claude-carried ghost', () => {
    const classified = classifyClaudeDocument(decodeJsonl(JSON.stringify({
      type: 'assistant',
      uuid: 'g-provisional-turn-0',
      sessionId: 'source',
      timestamp: '2026-07-20T12:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'provisional' }] },
      _atp: marker,
    })))
    const conversation = decodeClaudeConversation(classified.records)

    expect(classified.records[0]?.family).toBe('opaque')
    expect(analyzeClaudeTranscript(classified.records).prompts).toEqual([])
    expect(conversation.entries).toEqual([])
    expect(projectedStrings(conversation)).not.toContain('provisional-turn')
  })

  it('does not promote or project a Codex-carried ghost', () => {
    const classified = classifyCodexDocument(decodeJsonl(JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'provisional' }],
      },
      _atp: marker,
    })))
    const conversation = decodeCodexConversation(classified.records)

    expect(classified.records[0]?.family).toBe('opaque')
    expect(analyzeCodexTranscript(classified.records).prompts).toEqual([])
    expect(conversation.entries).toEqual([])
    expect(projectedStrings(conversation)).not.toContain('provisional-turn')
  })
})

function projectedStrings(conversation: ReturnType<typeof decodeClaudeConversation>): string {
  const options = {
    targetSessionId: '00000000-0000-4000-8000-000000000001',
    now: '2026-07-20T12:00:00.000Z',
    cwd: '/fixture/project',
  }
  return JSON.stringify([
    claudeArchiveProjector.projectArchive(conversation, options).values,
    codexArchiveProjector.projectArchive(conversation, options).values,
    claudeNativeResumeProjector.projectNativeResume(conversation, {
      ...options,
      version: 'fixture',
      model: 'fixture',
    }).values,
    codexNativeResumeProjector.projectNativeResume(conversation, {
      ...options,
      cliVersion: 'fixture',
      modelProvider: 'fixture',
      model: 'fixture',
    }).values,
  ])
}

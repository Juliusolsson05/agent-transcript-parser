import { describe, expect, it } from 'vitest'

import {
  assessConversationContextBudget,
  fitConversationToCharacterBudget,
} from '../../src/operations/contextBudget.js'
import type { ConversationDocument, ConversationEntry } from '../../src/conversation/types.js'

describe('context budget fitting', () => {
  it('keeps the largest recent suffix beginning at a complete user boundary', () => {
    const conversation: ConversationDocument = {
      schemaVersion: 1,
      sourceProvider: 'fixture',
      sourceSessionIds: ['source'],
      entries: [
        message('user', 'old question '.repeat(20), 0),
        message('assistant', 'old answer '.repeat(20), 1),
        message('user', 'recent question', 2),
        message('assistant', 'recent answer', 3),
      ],
    }
    const result = fitConversationToCharacterBudget(conversation, 100)

    expect(result).toMatchObject({ truncated: true, droppedEntries: 2 })
    expect(result.conversation.entries.map(entry => entry.kind)).toEqual([
      'compaction',
      'message',
      'message',
    ])
    expect(result.conversation.entries[1]).toMatchObject({
      kind: 'message',
      role: 'user',
      content: [{ kind: 'text', text: 'recent question' }],
    })
  })

  it('does not split a tool cycle away from its initiating user turn', () => {
    const conversation: ConversationDocument = {
      schemaVersion: 1,
      sourceProvider: 'fixture',
      sourceSessionIds: [],
      entries: [
        message('user', 'old'.repeat(100), 0),
        message('assistant', 'done'.repeat(100), 1),
        message('user', 'inspect', 2),
        toolCall(3),
        toolResult(4),
        message('assistant', 'result', 5),
      ],
    }
    const result = fitConversationToCharacterBudget(conversation, 180)

    expect(result.conversation.entries.slice(1).map(entry => entry.kind)).toEqual([
      'message',
      'tool-call',
      'tool-result',
      'message',
    ])
  })

  it('returns the original conversation when already within budget', () => {
    const conversation: ConversationDocument = {
      schemaVersion: 1,
      sourceProvider: 'fixture',
      sourceSessionIds: [],
      entries: [message('user', 'small', 0)],
    }
    const result = fitConversationToCharacterBudget(conversation, 1_000)

    expect(result.truncated).toBe(false)
    expect(result.conversation).toBe(conversation)
  })

  it('assesses only the source-provider context after its latest compaction', () => {
    const conversation: ConversationDocument = {
      schemaVersion: 1,
      sourceProvider: 'fixture',
      sourceSessionIds: ['source'],
      entries: [
        message('user', 'old context '.repeat(100), 0),
        message('assistant', 'old answer '.repeat(100), 1),
        {
          kind: 'compaction',
          summary: 'durable summary',
          ...source(2),
        },
        message('user', 'recent question', 3),
      ],
    }

    const result = assessConversationContextBudget(conversation, 100)

    expect(result).toMatchObject({
      requiresCompaction: false,
      usesExistingCompaction: true,
    })
    expect(result.conversation.entries).toEqual(conversation.entries.slice(2))
  })

  it('reports compaction instead of silently applying lossy truncation', () => {
    const conversation: ConversationDocument = {
      schemaVersion: 1,
      sourceProvider: 'fixture',
      sourceSessionIds: ['source'],
      entries: [message('user', 'too large '.repeat(100), 0)],
    }

    const result = assessConversationContextBudget(conversation, 100)

    expect(result.requiresCompaction).toBe(true)
    expect(result.conversation).toBe(conversation)
  })
})

function message(
  role: 'user' | 'assistant',
  text: string,
  line: number,
): ConversationEntry {
  return {
    kind: 'message',
    role,
    content: [{ kind: 'text', text }],
    ...source(line),
  }
}

function toolCall(line: number): ConversationEntry {
  return {
    kind: 'tool-call',
    callId: 'call-1',
    name: 'Read',
    input: { path: '/tmp/file' },
    nativeKind: 'fixture',
    ...source(line),
  }
}

function toolResult(line: number): ConversationEntry {
  return {
    kind: 'tool-result',
    callId: 'call-1',
    output: 'contents',
    isError: false,
    nativeKind: 'fixture',
    ...source(line),
  }
}

function source(line: number) {
  return {
    timestamp: '2026-07-21T00:00:00.000Z',
    source: {
      provider: 'fixture',
      line,
      raw: {},
      evidence: [],
    },
  }
}

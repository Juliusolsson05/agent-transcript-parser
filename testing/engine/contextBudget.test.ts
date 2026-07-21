import { describe, expect, it } from 'vitest'

import {
  assessConversationContextBudget,
  budgetCharactersForContextTokens,
  fitConversationToCharacterBudget,
  planConversationContext,
} from '../../src/operations/contextBudget.js'
import {
  describeLatestCompaction,
  portableCodexHandoffAfterLine,
} from '../../src/operations/compaction.js'
import type { ConversationDocument, ConversationEntry } from '../../src/conversation/types.js'
import { resolveCodexTargetProfileFromSources } from '../../src/codex/profile/targetProfile.js'

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

  it('plans from a portable compaction instead of exposing loose booleans to callers', () => {
    const conversation: ConversationDocument = {
      schemaVersion: 1,
      sourceProvider: 'claude',
      sourceSessionIds: ['source'],
      entries: [
        message('user', 'old context '.repeat(100), 0),
        {
          kind: 'compaction',
          summary: 'portable summary',
          summarySource: 'carrier',
          ...source(1),
        },
        message('user', 'recent question', 2),
      ],
    }

    const plan = planConversationContext(conversation, 'codex', 100)

    expect(plan).toMatchObject({
      kind: 'existing-compaction',
      compactionSourceLine: 1,
    })
    expect(plan.conversation.entries).toEqual(conversation.entries.slice(1))
  })

  it('requires a plaintext handoff for Codex encrypted compaction regardless of stale raw size', () => {
    const conversation: ConversationDocument = {
      schemaVersion: 1,
      sourceProvider: 'codex',
      sourceSessionIds: ['source'],
      entries: [{
        kind: 'compaction',
        summary: '',
        summarySource: 'encrypted',
        ...source(4),
      }],
    }

    expect(planConversationContext(conversation, 'claude', 10_000)).toMatchObject({
      kind: 'requires-portable-handoff',
      compactionSourceLine: 4,
    })
  })

  it('marks a Claude boundary placeholder incomplete until its carrier arrives', () => {
    const conversation: ConversationDocument = {
      schemaVersion: 1,
      sourceProvider: 'claude',
      sourceSessionIds: ['source'],
      entries: [{
        kind: 'compaction',
        summary: 'Conversation compacted',
        summarySource: 'boundary',
        ...source(8),
      }],
    }

    expect(describeLatestCompaction(conversation)?.availability).toBe('incomplete')
    conversation.entries[0] = {
      ...conversation.entries[0]!,
      kind: 'compaction',
      summary: 'Detailed provider-authored summary',
      summarySource: 'carrier',
    }
    expect(describeLatestCompaction(conversation)?.availability).toBe('portable')
  })

  it('accepts Codex handoff text only from a completed turn', () => {
    const conversation: ConversationDocument = {
      schemaVersion: 1,
      sourceProvider: 'codex',
      sourceSessionIds: ['source'],
      entries: [
        message('assistant', "I'll summarize.", 10),
        message('assistant', 'Detailed completed handoff.', 11),
        {
          kind: 'opaque',
          nativeType: 'event_msg',
          ...source(12, {
            type: 'event_msg',
            payload: {
              type: 'task_complete',
              last_agent_message: 'Detailed completed handoff.',
            },
          }),
        },
      ],
    }

    expect(portableCodexHandoffAfterLine(conversation, 9)).toMatchObject({
      summary: 'Detailed completed handoff.',
      completionLine: 12,
    })
    expect(portableCodexHandoffAfterLine({
      ...conversation,
      entries: conversation.entries.slice(0, 2),
    }, 9)).toBeNull()
  })

  it('derives character budgets from one documented token policy', () => {
    expect(budgetCharactersForContextTokens(200_000)).toBe(450_000)
    expect(budgetCharactersForContextTokens(272_000, {
      effectiveContextPercent: 95,
    })).toBe(581_400)
  })

  it('resolves the active Codex profile and never borrows another model budget', () => {
    const profile = resolveCodexTargetProfileFromSources(`
profile = "work"
model = "top-level"

[profiles.work]
model = "profile-model"
model_provider = "custom"
`, {
      models: [
        { slug: 'other-model', visibility: 'list', context_window: 1_000_000 },
        {
          slug: 'profile-model',
          visibility: 'list',
          context_window: 272_000,
          effective_context_window_percent: 95,
        },
      ],
    })

    expect(profile).toMatchObject({
      model: 'profile-model',
      modelProvider: 'custom',
      contextTokens: 272_000,
      effectiveContextPercent: 95,
      budgetCharacters: 581_400,
    })
    expect(resolveCodexTargetProfileFromSources('model = "missing"', {
      models: [{ slug: 'other-model', visibility: 'list', context_window: 1_000_000 }],
    })).toMatchObject({
      model: 'missing',
      contextTokens: 200_000,
      budgetCharacters: 405_000,
    })
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

function source(line: number, raw: Record<string, unknown> = {}) {
  return {
    timestamp: '2026-07-21T00:00:00.000Z',
    source: {
      provider: 'fixture',
      line,
      raw,
      evidence: [],
    },
  }
}

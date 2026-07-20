import { describe, expect, it } from 'vitest'

import { projectClaudeNativeResume } from '../../src/v2/claude/project/nativeResume.js'
import { projectCodexNativeResume } from '../../src/v2/codex/project/nativeResume.js'
import type { ConversationDocument, ConversationEntry } from '../../src/v2/conversation/types.js'
import { validateRollout } from '../codex-validator/src/validate.js'

const now = '2026-07-20T12:00:00.000Z'

describe('native-resume projection is distinct from archive projection', () => {
  it('does not mutate the neutral conversation while adding target evidence', () => {
    const document = conversation()
    const before = structuredClone(document)
    projectCodexNativeResume(document, {
      targetSessionId: 'codex-target',
      now,
      cwd: '/fixture/project',
      cliVersion: '0.144.6',
      modelProvider: 'openai',
      model: 'gpt-5',
    })
    projectClaudeNativeResume(document, {
      targetSessionId: 'claude-target',
      now,
      cwd: '/fixture/project',
      version: '2.1.215',
      model: 'claude-fixture',
    })
    expect(document).toEqual(before)
  })

  it('emits source-backed Codex rollout shapes with discovery and turn framing', () => {
    const result = projectCodexNativeResume(conversation(), {
      targetSessionId: '00000000-0000-4000-8000-000000000001',
      now,
      cwd: '/fixture/project',
      cliVersion: '0.144.6',
      modelProvider: 'openai',
      model: 'gpt-5',
    })

    expect(result.profile).toBe('native-resume')
    expect(result.providerProfile.id).toBe('codex-rollout-source-8035cb03')
    expect(result.values[0]).toMatchObject({
      type: 'session_meta',
      payload: {
        id: '00000000-0000-4000-8000-000000000001',
        cwd: '/fixture/project',
        source: 'cli',
        model_provider: 'openai',
      },
    })
    expect(result.values).toContainEqual(expect.objectContaining({
      type: 'event_msg',
      payload: expect.objectContaining({ type: 'user_message', message: 'hello' }),
    }))
    expect(result.values).toContainEqual(expect.objectContaining({
      type: 'turn_context',
      payload: expect.objectContaining({ cwd: '/fixture/project', model: 'gpt-5' }),
    }))
    expect(validateRollout(result.values)).toMatchObject({ ok: true, errorCount: 0 })
    expect(JSON.stringify(result.values)).not.toMatch(/atp_archive|atp_v2_archive|_atp/)
    expect(result.report.counts.dropped).toBe(1)
  })

  it('emits observation-scoped Claude records as one valid parent chain', () => {
    const result = projectClaudeNativeResume(conversation(), {
      targetSessionId: '00000000-0000-4000-8000-000000000002',
      now,
      cwd: '/fixture/project',
      version: '2.1.215',
      model: 'claude-fixture',
    })

    expect(result.profile).toBe('native-resume')
    expect(result.providerProfile.id).toBe('claude-observed-wire-2026-07-20')
    expect(result.values.map(value => value.type)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ])
    for (const [index, value] of result.values.entries()) {
      expect(value.sessionId).toBe('00000000-0000-4000-8000-000000000002')
      expect(value.parentUuid).toBe(index === 0 ? null : result.values[index - 1]?.uuid)
    }
    expect(result.values[1]?.message).toMatchObject({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call-1', name: 'Read' }],
    })
    expect(result.values[2]?.message).toMatchObject({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call-1' }],
    })
    expect(JSON.stringify(result.values)).not.toMatch(/atp_archive|atp_v2_archive|_atp/)
    expect(result.report.counts.dropped).toBe(1)
  })

  it('expands neutral compaction into each provider native resume shape', () => {
    const document: ConversationDocument = {
      schemaVersion: 1,
      sourceProvider: 'future-provider',
      sourceSessionIds: [],
      entries: [{
        kind: 'compaction',
        summary: 'keep this context',
        ...source(0, { type: 'future-compaction' }),
      }],
    }
    const codex = projectCodexNativeResume(document, {
      targetSessionId: 'codex-target',
      now,
      cwd: '/fixture/project',
      cliVersion: '0.144.6',
      modelProvider: 'openai',
      model: 'gpt-5',
    })
    const claude = projectClaudeNativeResume(document, {
      targetSessionId: 'claude-target',
      now,
      cwd: '/fixture/project',
      version: '2.1.215',
      model: 'claude-fixture',
    })

    expect(codex.values.map(value => value.type)).toEqual(['session_meta', 'compacted'])
    expect(validateRollout(codex.values)).toMatchObject({ ok: true, errorCount: 0 })
    expect(claude.values.map(value => [value.type, value.subtype])).toEqual([
      ['system', 'compact_boundary'],
      ['user', undefined],
    ])
    expect(claude.values[1]).toMatchObject({ isCompactSummary: true })
  })
})

function conversation(): ConversationDocument {
  return {
    schemaVersion: 1,
    sourceProvider: 'fixture-source',
    sourceSessionIds: ['source-session'],
    entries: [
      {
        kind: 'message',
        role: 'user',
        content: [{ kind: 'text', text: 'hello' }],
        ...source(0, { type: 'source-user' }),
      },
      {
        kind: 'tool-call',
        callId: 'call-1',
        name: 'Read',
        input: { path: '/fixture/file' },
        nativeKind: 'future-call',
        ...source(1, { type: 'source-call' }),
      },
      {
        kind: 'tool-result',
        callId: 'call-1',
        output: 'result',
        isError: false,
        nativeKind: 'future-result',
        ...source(2, { type: 'source-result' }),
      },
      {
        kind: 'message',
        role: 'assistant',
        content: [{ kind: 'text', text: 'done' }],
        ...source(3, { type: 'source-assistant' }),
      },
      {
        kind: 'opaque',
        nativeType: 'future-private-record',
        ...source(4, { type: 'future-private-record', value: 'archive only' }),
      },
    ],
  }
}

function source(
  line: number,
  raw: Record<string, unknown>,
): Pick<ConversationEntry, 'timestamp' | 'source'> {
  return {
    timestamp: now,
    source: { provider: 'fixture-source', line, raw, evidence: [] },
  }
}

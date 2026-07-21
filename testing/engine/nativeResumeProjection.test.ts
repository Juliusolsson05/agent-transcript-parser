import { describe, expect, it } from 'vitest'

import { classifyClaudeRecord } from '../../src/claude/classify/classify.js'
import { decodeClaudeConversation } from '../../src/claude/conversation/decode.js'
import { projectClaudeNativeResume } from '../../src/claude/project/nativeResume.js'
import { projectCodexNativeResume } from '../../src/codex/project/nativeResume.js'
import type { ConversationDocument, ConversationEntry } from '../../src/conversation/types.js'
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
    expect(JSON.stringify(result.values)).not.toMatch(/atp_archive|_atp/)
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
    expect(JSON.stringify(result.values)).not.toMatch(/atp_archive|_atp/)
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

    expect(codex.values.map(value => value.type)).toEqual(['session_meta', 'response_item'])
    expect(codex.values[1]).toMatchObject({
      payload: {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: expect.stringContaining('keep this context') }],
      },
    })
    expect(codex.report.changes).toContainEqual(expect.objectContaining({
      code: 'native-resume.compaction.foreign-summary-demoted',
      kind: 'demoted',
    }))
    expect(validateRollout(codex.values)).toMatchObject({ ok: true, errorCount: 0 })
    expect(claude.values.map(value => [value.type, value.subtype])).toEqual([
      ['system', 'compact_boundary'],
      ['user', undefined],
    ])
    expect(claude.values[1]).toMatchObject({ isCompactSummary: true })
  })

  it('prefers Claude compact-summary carrier text over its boundary placeholder', () => {
    const neutral = decodeClaudeConversation([
      classifyClaudeRecord({
        type: 'system',
        subtype: 'compact_boundary',
        content: 'Conversation compacted',
        sessionId: 'source',
        timestamp: now,
      }, 0),
      classifyClaudeRecord({
        type: 'user',
        isCompactSummary: true,
        sessionId: 'source',
        timestamp: now,
        message: {
          role: 'user',
          content: 'Detailed portable summary of the actual work.',
        },
      }, 1),
    ])

    expect(neutral.entries).toEqual([expect.objectContaining({
      kind: 'compaction',
      summary: 'Detailed portable summary of the actual work.',
    })])
  })

  it('drops unmatched tool plumbing before either provider can repair it differently', () => {
    const document: ConversationDocument = {
      schemaVersion: 1,
      sourceProvider: 'future-provider',
      sourceSessionIds: [],
      entries: [{
        kind: 'tool-call',
        callId: 'orphan',
        name: 'Read',
        input: {},
        nativeKind: 'future-call',
        ...source(0, { type: 'source-call' }),
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

    expect(codex.values.map(value => value.type)).toEqual(['session_meta'])
    expect(claude.values).toEqual([])
    expect(codex.report.changes.map(change => change.code)).toContain(
      'native-resume.tool-call.unmatched-dropped',
    )
    expect(claude.report.changes.map(change => change.code)).toContain(
      'native-resume.tool-call.unmatched-dropped',
    )
  })

  it('preserves mixed Claude block order through neutral and native projection', () => {
    const neutral = decodeClaudeConversation([
      classifyClaudeRecord({
        type: 'assistant',
        uuid: 'assistant-1',
        sessionId: 'source',
        timestamp: now,
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'before' },
            { type: 'thinking', thinking: 'reason' },
            { type: 'text', text: 'after' },
            { type: 'tool_use', id: 'call-1', name: 'Read', input: {} },
          ],
        },
      }, 0),
      classifyClaudeRecord({
        type: 'user',
        uuid: 'result-1',
        parentUuid: 'assistant-1',
        sessionId: 'source',
        timestamp: now,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'done' }],
        },
      }, 1),
    ])

    expect(neutral.entries.map(entry => entry.kind)).toEqual([
      'message',
      'reasoning',
      'message',
      'tool-call',
      'tool-result',
    ])
    const claude = projectClaudeNativeResume(neutral, {
      targetSessionId: 'claude-target',
      now,
      cwd: '/fixture/project',
      version: 'fixture',
      model: 'fixture',
    })
    expect(claude.values[0]?.message).toMatchObject({
      content: [
        { type: 'text', text: 'before' },
        { type: 'thinking', thinking: 'reason' },
        { type: 'text', text: 'after' },
        { type: 'tool_use', id: 'call-1' },
      ],
    })
  })

  it('drops a tool cycle that crosses a user boundary instead of writing invalid Claude history', () => {
    const document: ConversationDocument = {
      schemaVersion: 1,
      sourceProvider: 'future-provider',
      sourceSessionIds: [],
      entries: [
        { kind: 'tool-call', callId: 'c1', name: 'Read', input: {}, nativeKind: 'future', ...source(0, {}) },
        { kind: 'message', role: 'user', content: [{ kind: 'text', text: 'interrupt' }], ...source(1, {}) },
        { kind: 'tool-result', callId: 'c1', output: 'late', isError: false, nativeKind: 'future', ...source(2, {}) },
      ],
    }
    const result = projectClaudeNativeResume(document, {
      targetSessionId: 'claude-target',
      now,
      cwd: '/fixture/project',
      version: 'fixture',
      model: 'fixture',
    })

    expect(result.values).toHaveLength(1)
    expect(result.values[0]).toMatchObject({ type: 'user', message: { content: 'interrupt' } })
    expect(result.report.changes.filter(change => change.code.includes('non-adjacent'))).toHaveLength(2)
  })

  it('repairs non-object Codex tool input before Claude API resume', () => {
    const document: ConversationDocument = {
      schemaVersion: 1,
      sourceProvider: 'codex',
      sourceSessionIds: ['source'],
      entries: [
        {
          kind: 'tool-call',
          callId: 'custom-1',
          name: 'apply_patch',
          input: '*** Begin Patch',
          nativeKind: 'custom_tool_call',
          ...source(0, {}),
        },
        {
          kind: 'tool-result',
          callId: 'custom-1',
          output: [{ type: 'input_text', text: 'Done!' }],
          isError: false,
          nativeKind: 'custom_tool_call_output',
          ...source(1, {}),
        },
      ],
    }
    const result = projectClaudeNativeResume(document, {
      targetSessionId: 'claude-target',
      now,
      cwd: '/fixture/project',
      version: 'fixture',
      model: 'fixture',
    })

    expect(result.values[0]).toMatchObject({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'custom-1',
          input: { input: '*** Begin Patch' },
        }],
      },
    })
    expect(result.values[1]).toMatchObject({
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'custom-1',
          content: [{ type: 'text', text: 'Done!' }],
        }],
      },
    })
    expect(result.report.changes.map(change => change.code)).toContain(
      'native-resume.tool-call.input-object-repaired',
    )
    expect(result.report.changes.map(change => change.code)).toContain(
      'native-resume.tool-result.content-blocks-repaired',
    )
  })

  it('does not send Claude reasoning ciphertext to Codex', () => {
    const document: ConversationDocument = {
      schemaVersion: 1,
      sourceProvider: 'claude',
      sourceSessionIds: ['source'],
      entries: [
        {
          kind: 'message',
          role: 'user',
          content: [{ kind: 'text', text: 'question' }],
          ...source(0, {}),
        },
        {
          kind: 'reasoning',
          text: 'portable plaintext',
          encrypted: 'claude-only-signature',
          ...source(1, {}),
        },
        {
          kind: 'message',
          role: 'assistant',
          content: [{ kind: 'text', text: 'answer' }],
          ...source(2, {}),
        },
      ],
    }
    const result = projectCodexNativeResume(document, {
      targetSessionId: 'codex-target',
      now,
      cwd: '/fixture/project',
      cliVersion: 'fixture',
      modelProvider: 'openai',
      model: 'fixture',
    })
    const reasoning = result.values.find(value => (
      value.type === 'response_item' && (value.payload as { type?: string }).type === 'reasoning'
    ))

    expect(reasoning).toMatchObject({
      payload: {
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'portable plaintext' }],
      },
    })
    expect(reasoning?.payload).not.toHaveProperty('encrypted_content')
    expect(result.report.changes.map(change => change.code)).toContain(
      'native-resume.reasoning.encrypted-content-demoted',
    )
  })

  it('does not send Codex reasoning ciphertext to Claude', () => {
    const document: ConversationDocument = {
      schemaVersion: 1,
      sourceProvider: 'codex',
      sourceSessionIds: ['source'],
      entries: [
        {
          kind: 'message',
          role: 'user',
          content: [{ kind: 'text', text: 'question' }],
          ...source(0, {}),
        },
        {
          kind: 'reasoning',
          text: 'codex reasoning summary',
          encrypted: 'codex-only-ciphertext',
          ...source(1, {}),
        },
        {
          kind: 'message',
          role: 'assistant',
          content: [{ kind: 'text', text: 'answer' }],
          ...source(2, {}),
        },
      ],
    }

    const result = projectClaudeNativeResume(document, {
      targetSessionId: 'claude-target',
      now,
      cwd: '/fixture/project',
      version: 'fixture',
      model: 'fixture',
    })

    expect(JSON.stringify(result.values)).not.toContain('codex-only-ciphertext')
    expect(JSON.stringify(result.values)).not.toContain('"type":"thinking"')
    expect(result.report.changes.map(change => change.code)).toContain(
      'native-resume.reasoning.foreign-dropped',
    )
  })

  it('preserves provider-authenticated Codex compaction for same-provider clones', () => {
    const rawCompaction = {
      timestamp: now,
      type: 'compacted',
      payload: {
        message: '',
        replacement_history: [{ type: 'encrypted', encrypted_content: 'provider-cipher' }],
      },
    }
    const document: ConversationDocument = {
      schemaVersion: 1,
      sourceProvider: 'codex',
      sourceSessionIds: ['source'],
      entries: [{
        kind: 'compaction',
        summary: '',
        summarySource: 'encrypted',
        ...source(4, rawCompaction),
      }],
    }

    const result = projectCodexNativeResume(document, {
      targetSessionId: 'codex-target',
      now,
      cwd: '/fixture/project',
      cliVersion: 'fixture',
      modelProvider: 'openai',
      model: 'fixture',
    })

    expect(result.values).toContainEqual(rawCompaction)
    expect(JSON.stringify(result.values)).toContain('provider-cipher')
    expect(result.report.changes).toContainEqual(expect.objectContaining({
      kind: 'preserved',
      code: 'native-resume.compaction.preserved',
    }))
  })

  it('trims reasoning that becomes the Codex response-item tail', () => {
    const document: ConversationDocument = {
      schemaVersion: 1,
      sourceProvider: 'codex',
      sourceSessionIds: ['source'],
      entries: [
        { kind: 'message', role: 'user', content: [{ kind: 'text', text: 'work' }], ...source(0, {}) },
        { kind: 'reasoning', text: 'unfinished', encrypted: 'cipher', ...source(1, {}) },
        { kind: 'tool-call', callId: 'orphan', name: 'apply_patch', input: 'patch', nativeKind: 'custom_tool_call', ...source(2, {}) },
      ],
    }
    const result = projectCodexNativeResume(document, {
      targetSessionId: 'codex-target',
      now,
      cwd: '/fixture/project',
      cliVersion: 'fixture',
      modelProvider: 'openai',
      model: 'fixture',
    })

    expect(result.values.some(value => (
      value.type === 'response_item' && (value.payload as { type?: string }).type === 'reasoning'
    ))).toBe(false)
    expect(result.report.changes.map(change => change.code)).toContain('native-resume.reasoning.trailing-dropped')
  })

  it('retains unknown same-provider message blocks but drops them cross-provider', () => {
    const entry: ConversationEntry = {
      kind: 'message',
      role: 'assistant',
      content: [{ kind: 'opaque', nativeType: 'future_block', value: { type: 'future_block', payload: 'kept' } }],
      ...source(0, {}),
    }
    const sameProvider = projectClaudeNativeResume({
      schemaVersion: 1,
      sourceProvider: 'claude',
      sourceSessionIds: ['source'],
      entries: [entry],
    }, {
      targetSessionId: 'claude-target', now, cwd: '/fixture/project', version: 'fixture', model: 'fixture',
    })
    const crossProvider = projectClaudeNativeResume({
      schemaVersion: 1,
      sourceProvider: 'future-provider',
      sourceSessionIds: [],
      entries: [entry],
    }, {
      targetSessionId: 'claude-target', now, cwd: '/fixture/project', version: 'fixture', model: 'fixture',
    })

    expect(sameProvider.values[0]?.message).toMatchObject({ content: [{ type: 'future_block', payload: 'kept' }] })
    expect(crossProvider.values).toEqual([])
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

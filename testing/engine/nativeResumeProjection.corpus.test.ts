import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import { classifyClaudeDocument, classifyClaudeRecord } from '../../src/claude/classify/index.js'
import {
  claudeConversationDecoder,
  decodeClaudeConversation,
} from '../../src/claude/conversation/index.js'
import { projectClaudeNativeResume } from '../../src/claude/project/index.js'
import { classifyCodexDocument } from '../../src/codex/classify/index.js'
import { decodeCodexConversation } from '../../src/codex/conversation/index.js'
import {
  codexNativeResumeProjector,
  projectCodexNativeResume,
} from '../../src/codex/project/index.js'
import { decodeJsonl } from '../../src/jsonl/codec.js'
import { validateRollout } from '../codex-validator/src/validate.js'
import { translateNativeResume } from '../../src/translation/nativeResume.js'

const sequences = new URL('../../fixtures/evidence/observed-sequences/', import.meta.url)
const now = '2026-07-20T12:00:00.000Z'

describe('native-resume projection over observed provider sequences', () => {
  it('produces a schema-valid Codex rollout from observed Claude prompts', async () => {
    const source = await fixture('claude-sequence-prompts')
    const records = classifyClaudeDocument(decodeJsonl(source)).records
    const result = translateNativeResume(
      claudeConversationDecoder,
      codexNativeResumeProjector,
      records,
      codexOptions(),
    )
    const validation = validateRollout(result.values)

    expect(validation).toMatchObject({ ok: true, errorCount: 0, warnCount: 0 })
    expect(result.values.filter(value => value.type === 'turn_context')).toHaveLength(3)
    expect(result.values.filter(value => (
      value.type === 'event_msg' &&
      isRecord(value.payload) &&
      value.payload.type === 'user_message'
    ))).toHaveLength(3)
  })

  it('preserves observed Claude tool identity in a schema-valid Codex rollout', async () => {
    const source = await fixture('claude-sequence-tool-cycle')
    const neutral = decodeClaudeConversation(classifyClaudeDocument(decodeJsonl(source)).records)
    const result = projectCodexNativeResume(neutral, codexOptions())
    const responseItems = result.values
      .filter(value => value.type === 'response_item')
      .map(value => value.payload)
      .filter(isRecord)
    const call = responseItems.find(value => value.type === 'function_call')
    const output = responseItems.find(value => value.type === 'function_call_output')

    expect(validateRollout(result.values)).toMatchObject({ ok: true, errorCount: 0 })
    expect(call?.call_id).toBe(output?.call_id)
  })

  it('produces an observed Claude parent chain from Codex prompts', async () => {
    const source = await fixture('codex-sequence-prompts')
    const neutral = decodeCodexConversation(classifyCodexDocument(decodeJsonl(source)).records)
    const result = projectClaudeNativeResume(neutral, claudeOptions())

    expect(result.values.map(value => value.type)).toEqual(['user', 'user', 'user'])
    expect(result.values.map(classifyClaudeRecord).every(record => record.family === 'user-message')).toBe(true)
    for (const [index, value] of result.values.entries()) {
      expect(value.parentUuid).toBe(index === 0 ? null : result.values[index - 1]?.uuid)
    }
  })

  it('preserves observed Codex tool identity in Claude tool blocks', async () => {
    const source = await fixture('codex-sequence-tool-cycle')
    const neutral = decodeCodexConversation(classifyCodexDocument(decodeJsonl(source)).records)
    const result = projectClaudeNativeResume(neutral, claudeOptions())
    const decoded = decodeClaudeConversation(result.values.map(classifyClaudeRecord))
    const call = decoded.entries.find(entry => entry.kind === 'tool-call')
    const output = decoded.entries.find(entry => entry.kind === 'tool-result')

    expect(call?.kind).toBe('tool-call')
    expect(output?.kind).toBe('tool-result')
    if (call?.kind === 'tool-call' && output?.kind === 'tool-result') {
      expect(call.callId).toBe(output.callId)
    }
  })
})

function codexOptions() {
  return {
    targetSessionId: '00000000-0000-4000-8000-000000000003',
    now,
    cwd: '/fixture/project',
    cliVersion: '0.144.6',
    modelProvider: 'openai',
    model: 'gpt-5',
  }
}

function claudeOptions() {
  return {
    targetSessionId: '00000000-0000-4000-8000-000000000004',
    now,
    cwd: '/fixture/project',
    version: '2.1.215',
    model: 'claude-fixture',
  }
}

function fixture(caseId: string): Promise<string> {
  return readFile(new URL(`${caseId}/source.jsonl`, sequences), 'utf8')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

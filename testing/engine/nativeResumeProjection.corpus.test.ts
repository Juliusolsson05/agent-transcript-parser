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
const observed = new URL('../../fixtures/evidence/observed/', import.meta.url)
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

  it('decodes one Claude compaction without fabricating a user prompt', async () => {
    const source = await fixture('claude-sequence-compaction')
    const neutral = decodeClaudeConversation(classifyClaudeDocument(decodeJsonl(source)).records)
    const compactions = neutral.entries.filter(entry => entry.kind === 'compaction')
    const userMessages = neutral.entries.filter(entry => entry.kind === 'message' && entry.role === 'user')

    expect(compactions).toHaveLength(1)
    expect(compactions[0]).toMatchObject({ summary: 'fixture text' })
    expect(userMessages).toEqual([])

    const codex = projectCodexNativeResume(neutral, codexOptions())
    const claude = projectClaudeNativeResume(neutral, claudeOptions())
    expect(codex.values.find(value => (
      value.type === 'response_item' &&
      isRecord(value.payload) &&
      value.payload.role === 'developer'
    ))).toMatchObject({
      payload: {
        content: [{ type: 'input_text', text: expect.stringContaining('fixture text') }],
      },
    })
    expect(codex.values.some(value => (
      value.type === 'event_msg' && isRecord(value.payload) && value.payload.type === 'user_message'
    ))).toBe(false)
    expect(claude.values.map(value => value.type)).toEqual(['system', 'user'])
    expect(claude.values[0]).toMatchObject({ content: 'fixture text' })
    expect(claude.values[1]).toMatchObject({ isCompactSummary: true })
  })

  it('preserves Codex custom tool call wire kinds and opaque input', async () => {
    const [call, output] = await Promise.all([
      observedFixture('codex-payload-custom-tool-call'),
      observedFixture('codex-payload-custom-tool-call-output'),
    ])
    const neutral = decodeCodexConversation(classifyCodexDocument(decodeJsonl(`${call}${output}`)).records)
    const result = projectCodexNativeResume(neutral, codexOptions())
    const items = result.values
      .filter(value => value.type === 'response_item')
      .map(value => value.payload)
      .filter(isRecord)

    expect(items).toContainEqual(expect.objectContaining({
      type: 'custom_tool_call',
      call_id: 'fixture-id-1',
      input: 'fixture text',
    }))
    expect(items).toContainEqual(expect.objectContaining({
      type: 'custom_tool_call_output',
      call_id: 'fixture-id-1',
    }))
    expect(validateRollout(result.values)).toMatchObject({ ok: true, errorCount: 0 })
  })

  it('preserves a Codex local shell call instead of inventing a function name', async () => {
    const call = await observedFixture('codex-payload-local-shell-call')
    const output = JSON.stringify({
      timestamp: now,
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'fixture-id-1', output: 'done' },
    })
    const neutral = decodeCodexConversation(classifyCodexDocument(decodeJsonl(`${call}${output}\n`)).records)
    const result = projectCodexNativeResume(neutral, codexOptions())
    const items = result.values
      .filter(value => value.type === 'response_item')
      .map(value => value.payload)
      .filter(isRecord)

    expect(items).toContainEqual(expect.objectContaining({
      type: 'local_shell_call',
      call_id: 'fixture-id-1',
      action: expect.objectContaining({ type: 'exec' }),
    }))
    expect(items).not.toContainEqual(expect.objectContaining({
      type: 'function_call',
      name: 'local_shell_call',
    }))
    expect(validateRollout(result.values)).toMatchObject({ ok: true, errorCount: 0 })
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

function observedFixture(caseId: string): Promise<string> {
  return readFile(new URL(`${caseId}/source.jsonl`, observed), 'utf8')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

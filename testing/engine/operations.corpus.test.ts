import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import { analyzeClaudeTranscript } from '../../src/claude/analyze/index.js'
import { classifyClaudeDocument } from '../../src/claude/classify/index.js'
import { decodeClaudeConversation } from '../../src/claude/conversation/index.js'
import { claudeNativeResumeProjector } from '../../src/claude/project/index.js'
import { analyzeCodexTranscript } from '../../src/codex/analyze/index.js'
import { classifyCodexDocument } from '../../src/codex/classify/index.js'
import { decodeCodexConversation } from '../../src/codex/conversation/index.js'
import { codexNativeResumeProjector } from '../../src/codex/project/index.js'
import { decodeJsonl } from '../../src/jsonl/codec.js'
import { cloneForNativeResume, rewindForNativeResume } from '../../src/operations/nativeResume.js'
import {
  PromptAddressNotFoundError,
  rewindConversation,
} from '../../src/operations/conversation.js'
import { samePromptAddress } from '../../src/operations/promptAddress.js'
import { validateRollout } from '../codex-validator/src/validate.js'

const sequences = new URL('../../fixtures/evidence/observed-sequences/', import.meta.url)
const now = '2026-07-20T12:00:00.000Z'

describe('clone and rewind through stable provider addresses', () => {
  it('rewinds Codex at the exact response record without retaining its duplicate event', async () => {
    const records = classifyCodexDocument(decodeJsonl(await fixture('codex-sequence-prompts'))).records
    const analysis = analyzeCodexTranscript(records)
    const conversation = decodeCodexConversation(records)
    const address = analysis.prompts[1]!.address
    const result = rewindForNativeResume(
      conversation,
      address,
      codexNativeResumeProjector,
      codexOptions(),
    )

    expect(address.line).toBe(4)
    expect(result.operation).toBe('rewind')
    expect(result.draft).toEqual([{ kind: 'text', text: 'fixture text' }])
    expect(result.values.filter(isCodexUserResponse)).toHaveLength(1)
    expect(result.values.filter(isCodexUserEvent)).toHaveLength(1)
    expect(validateRollout(result.values)).toMatchObject({ ok: true, errorCount: 0, warnCount: 0 })
  })

  it('rewinds Claude using the same address object returned to the UI', async () => {
    const records = classifyClaudeDocument(decodeJsonl(await fixture('claude-sequence-prompts'))).records
    const analysis = analyzeClaudeTranscript(records)
    const conversation = decodeClaudeConversation(records)
    const address = analysis.prompts[1]!.address
    const result = rewindForNativeResume(
      conversation,
      address,
      claudeNativeResumeProjector,
      claudeOptions(),
    )

    expect(address.line).toBe(1)
    expect(result.values.map(value => value.type)).toEqual(['user'])
    expect(result.draft).toEqual([{ kind: 'text', text: 'fixture text' }])
  })

  it('clones the complete neutral conversation under a fresh provider identity', async () => {
    const records = classifyCodexDocument(decodeJsonl(await fixture('codex-sequence-prompts'))).records
    const conversation = decodeCodexConversation(records)
    const before = structuredClone(conversation)
    const clone = cloneForNativeResume(
      conversation,
      claudeNativeResumeProjector,
      claudeOptions(),
    )

    expect(clone.operation).toBe('clone')
    expect(clone.targetProvider).toBe('claude')
    expect(clone.values.map(value => value.type)).toEqual(['user', 'user', 'user'])
    expect(conversation).toEqual(before)
  })

  it('rejects stale or reconstructed addresses rather than falling back to an ordinal', async () => {
    const records = classifyCodexDocument(decodeJsonl(await fixture('codex-sequence-prompts'))).records
    const conversation = decodeCodexConversation(records)
    expect(() => rewindConversation(conversation, {
      provider: 'codex',
      line: 999,
      sessionId: conversation.sourceSessionIds[0] ?? null,
    })).toThrow(PromptAddressNotFoundError)
  })

  it('allows future providers to use the universal stable coordinate', () => {
    expect(samePromptAddress(
      { provider: 'future-provider', line: 7, sessionId: 'session' },
      { provider: 'future-provider', line: 7, sessionId: 'session' },
    )).toBe(true)
  })
})

function isCodexUserResponse(value: Record<string, unknown>): boolean {
  return value.type === 'response_item' && isRecord(value.payload) && (
    value.payload.type === 'message' && value.payload.role === 'user'
  )
}

function isCodexUserEvent(value: Record<string, unknown>): boolean {
  return value.type === 'event_msg' && isRecord(value.payload) && value.payload.type === 'user_message'
}

function codexOptions() {
  return {
    targetSessionId: '00000000-0000-4000-8000-000000000005',
    now,
    cwd: '/fixture/project',
    cliVersion: '0.144.6',
    modelProvider: 'openai',
    model: 'gpt-5',
  }
}

function claudeOptions() {
  return {
    targetSessionId: '00000000-0000-4000-8000-000000000006',
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

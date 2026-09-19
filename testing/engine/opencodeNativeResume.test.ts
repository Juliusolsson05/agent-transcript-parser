import { describe, expect, it } from 'vitest'

import { decodeOpencodeConversation } from '../../src/opencode/conversation/decode.js'
import { projectOpencodeNativeResume } from '../../src/opencode/project/nativeResume.js'
import type { ConversationDocument } from '../../src/conversation/types.js'

const source: ConversationDocument = {
  schemaVersion: 1,
  sourceProvider: 'codex',
  sourceSessionIds: ['source'],
  entries: [
    message('user', 'Build it', 0),
    {
      kind: 'tool-call',
      callId: 'call_1',
      name: 'shell',
      input: { command: 'pwd' },
      nativeKind: 'function_call',
      timestamp: '2026-09-03T12:00:01.000Z',
      source: sourceAt(1),
    },
    {
      kind: 'tool-result',
      callId: 'call_1',
      output: '/workspace',
      isError: false,
      nativeKind: 'function_call_output',
      timestamp: '2026-09-03T12:00:02.000Z',
      source: sourceAt(2),
    },
    message('assistant', 'Finished', 3),
  ],
}

describe('projectOpencodeNativeResume', () => {
  it('creates importable native IDs and one combined OpenCode tool part', () => {
    const projection = projectOpencodeNativeResume(source, {
      cwd: '/workspace',
      targetSessionId: 'target-session',
      now: '2026-09-03T12:00:00.000Z',
      cliVersion: '1.18.27',
      modelProvider: 'openai',
      model: 'gpt-5',
    })
    const exported = projection.values[0] as {
      info: Record<string, unknown>
      messages: Array<{ info: Record<string, unknown>; parts: Record<string, unknown>[] }>
    }

    expect(exported.info.id).toMatch(/^ses_/)
    expect(exported.messages.every(message => String(message.info.id).startsWith('msg_'))).toBe(true)
    expect(exported.messages.flatMap(message => message.parts)
      .every(part => String(part.id).startsWith('prt_'))).toBe(true)
    expect(exported.messages.flatMap(message => message.parts)).toContainEqual(
      expect.objectContaining({
        type: 'tool',
        callID: 'call_1',
        state: expect.objectContaining({ status: 'completed', output: '/workspace' }),
      }),
    )
    expect(projection.report.counts.preserved).toBe(4)
  })

  // Agent Code switch B18 review: OpenCode Terminal restores the model AND
  // its reasoning variant from the last user message, and saves that variant
  // to model.json. A message without one reset the user's saved effort (for
  // example glm-5.3 at "max") to "default" the first time the pane opened.
  // The shape is OpenCode 1.18.31's user-message schema:
  // model: { providerID, modelID, variant?: string }.
  it('stamps the model variant on user messages, and omits "default" as OpenCode does', () => {
    const project = (modelVariant?: string) => projectOpencodeNativeResume(source, {
      cwd: '/workspace', targetSessionId: 'target-session', now: '2026-09-03T12:00:00.000Z',
      cliVersion: '1.18.31', modelProvider: 'zai-coding-plan', model: 'glm-5.3', modelVariant,
    }).values[0] as { messages: Array<{ info: { role: string; model?: Record<string, unknown> } }> }
    const userModels = (modelVariant?: string) => project(modelVariant).messages
      .filter(message => message.info.role === 'user').map(message => message.info.model)

    expect(userModels('max')).toEqual([{ providerID: 'zai-coding-plan', modelID: 'glm-5.3', variant: 'max' }])
    expect(userModels('default')).toEqual([{ providerID: 'zai-coding-plan', modelID: 'glm-5.3' }])
    expect(userModels(undefined)).toEqual([{ providerID: 'zai-coding-plan', modelID: 'glm-5.3' }])
  })

  it('round-trips projected semantic content through the OpenCode decoder', () => {
    const projection = projectOpencodeNativeResume(source, {
      cwd: '/workspace',
      targetSessionId: 'target-session',
      now: '2026-09-03T12:00:00.000Z',
      cliVersion: '1.18.27',
      modelProvider: 'openai',
      model: 'gpt-5',
    })
    const decoded = decodeOpencodeConversation(projection.values[0])

    expect(decoded.entries.map(entry => entry.kind)).toEqual([
      'message', 'tool-call', 'tool-result', 'message',
    ])
    expect(decoded.entries[0]).toMatchObject({ role: 'user', content: [{ text: 'Build it' }] })
    expect(decoded.entries[3]).toMatchObject({ role: 'assistant', content: [{ text: 'Finished' }] })
  })
})

function message(role: 'user' | 'assistant', text: string, line: number) {
  return {
    kind: 'message' as const,
    role,
    content: [{ kind: 'text' as const, text }],
    timestamp: `2026-09-03T12:00:0${line}.000Z`,
    source: sourceAt(line),
  }
}

function sourceAt(line: number) {
  return { provider: 'codex', line, raw: {}, evidence: [] }
}

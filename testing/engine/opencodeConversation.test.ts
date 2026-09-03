import { describe, expect, it } from 'vitest'

import { decodeOpencodeConversation } from '../../src/opencode/conversation/decode.js'

describe('decodeOpencodeConversation', () => {
  it('decodes ordered OpenCode message parts and complete tool cycles', () => {
    const conversation = decodeOpencodeConversation({
      info: { id: 'ses_source' },
      messages: [
        {
          info: {
            id: 'msg_user',
            sessionID: 'ses_source',
            role: 'user',
            time: { created: 1_700_000_000_000 },
          },
          parts: [
            { type: 'text', text: 'Inspect this image' },
            { type: 'file', mime: 'image/png', url: 'data:image/png;base64,AAAA' },
          ],
        },
        {
          info: {
            id: 'msg_assistant',
            sessionID: 'ses_source',
            role: 'assistant',
            time: { created: 1_700_000_001_000, completed: 1_700_000_002_000 },
          },
          parts: [
            { type: 'reasoning', text: 'Need the file', time: { start: 1_700_000_001_100 } },
            {
              type: 'tool',
              callID: 'call_1',
              tool: 'read',
              state: {
                status: 'completed',
                input: { path: 'a.png' },
                output: 'ok',
                title: 'read',
                metadata: {},
                time: { start: 1_700_000_001_200, end: 1_700_000_001_300 },
              },
            },
            { type: 'text', text: 'Done' },
          ],
        },
      ],
    })

    expect(conversation.sourceProvider).toBe('opencode')
    expect(conversation.sourceSessionIds).toEqual(['ses_source'])
    expect(conversation.entries.map(entry => entry.kind)).toEqual([
      'message',
      'reasoning',
      'tool-call',
      'tool-result',
      'message',
    ])
    expect(conversation.entries[0]).toMatchObject({
      kind: 'message',
      role: 'user',
      content: [
        { kind: 'text', text: 'Inspect this image' },
        { kind: 'image' },
      ],
    })
    expect(conversation.entries[2]).toMatchObject({
      kind: 'tool-call', callId: 'call_1', name: 'read', input: { path: 'a.png' },
    })
    expect(conversation.entries[3]).toMatchObject({
      kind: 'tool-result', callId: 'call_1', output: 'ok', isError: false,
    })
  })

  it('rejects malformed export envelopes at the native boundary', () => {
    expect(() => decodeOpencodeConversation({ info: {}, messages: [{}] }))
      .toThrow(/message 0/)
  })

  it('keeps unknown user and assistant parts opaque instead of silently dropping them', () => {
    const conversation = decodeOpencodeConversation({
      info: { id: 'ses_source' },
      messages: [
        {
          info: { sessionID: 'ses_source', role: 'user', time: { created: 1 } },
          parts: [{ type: 'future-user-context', value: 1 }],
        },
        {
          info: {
            sessionID: 'ses_source', role: 'assistant',
            time: { created: 2, completed: 3 },
          },
          parts: [{ type: 'step-start', snapshot: 'abc' }],
        },
      ],
    })

    expect(conversation.entries).toEqual([
      expect.objectContaining({
        kind: 'message',
        role: 'user',
        content: [expect.objectContaining({
          kind: 'opaque',
          nativeType: 'future-user-context',
        })],
      }),
      expect.objectContaining({ kind: 'opaque', nativeType: 'step-start' }),
    ])
  })
})

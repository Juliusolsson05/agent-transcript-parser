import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decodeGrokConversation } from '../../src/grok/conversation/decode.js'

const records = readFileSync(new URL('../../fixtures/evidence/grok/command.jsonl', import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line))

describe('recorded Grok conversation semantics', () => {
  it('keeps bootstrap/provider instructions out of human turns and preserves operation order', () => {
    const document = decodeGrokConversation(records, { sessionId: 'source-session' })
    expect(document.sourceProvider).toBe('grok')
    expect(document.sourceSessionIds).toEqual(['source-session'])
    expect(document.entries.map(entry => entry.kind)).toEqual(['opaque', 'opaque', 'opaque', 'message', 'reasoning', 'message', 'tool-call', 'tool-result', 'message'])
    const users = document.entries.filter(entry => entry.kind === 'message' && entry.role === 'user')
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject({ content: [{ kind: 'text', text: 'Run this exact shell command: touch PERMISSION_PROBE.txt' }], source: { line: 3 } })
    const call = document.entries.find(entry => entry.kind === 'tool-call')
    expect(call).toMatchObject({ callId: 'call_fixture', name: 'run_terminal_command', input: { command: 'touch PERMISSION_PROBE.txt' }, source: { line: 5 } })
    expect(document.entries.find(entry => entry.kind === 'tool-result')).toMatchObject({ callId: 'call_fixture', output: 'exit: 0' })
    expect(document.entries.every(entry => entry.timestamp === null)).toBe(true)
  })

  it('preserves unknown record shapes as opaque evidence instead of invented speech', () => {
    const raw = { type: 'future_grok_record', data: { arbitrary: 'recorded elsewhere' } }
    expect(decodeGrokConversation([raw]).entries).toEqual([expect.objectContaining({ kind: 'opaque', nativeType: 'future_grok_record', source: expect.objectContaining({ raw }) })])
  })

  it('does not interpret ordinary user text containing metadata tags as bootstrap', () => {
    const document = decodeGrokConversation([{ type: 'user', content: [{ type: 'text', text: 'Explain <user_info> and <user_query> tags.' }] }])
    expect(document.entries[0]).toMatchObject({ kind: 'message', role: 'user', content: [{ kind: 'text', text: 'Explain <user_info> and <user_query> tags.' }] })
  })

  it('does not turn the broad compaction_meta tag into a truncating compaction boundary', () => {
    const document = decodeGrokConversation([{ type: 'user', synthetic_reason: 'compaction_meta', content: [{ type: 'text', text: 'Retained summary/context' }] }])
    expect(document.entries[0]).toMatchObject({ kind: 'message', role: 'developer', content: [{ kind: 'text', text: 'Retained summary/context' }] })
  })

  it('retains malformed tool calls as opaque instead of manufacturing IDs or empty arguments', () => {
    const document = decodeGrokConversation([{ type: 'assistant', content: '', tool_calls: [{ id: 'bad', name: 'run_terminal_command', arguments: '{' }] }])
    expect(document.entries).toEqual([expect.objectContaining({ kind: 'opaque', nativeType: 'grok.invalid-tool-call' })])
  })

  it('preserves user-originated interjections despite their synthetic storage tag', () => {
    const document = decodeGrokConversation([{ type: 'user', synthetic_reason: 'interjection', content: [{ type: 'text', text: 'Stop editing and explain the change.' }] }])
    expect(document.entries[0]).toMatchObject({ kind: 'message', role: 'user', content: [{ kind: 'text', text: 'Stop editing and explain the change.' }] })
  })

  it('recognizes bootstrap context before the first user request even after multiple system records', () => {
    const document = decodeGrokConversation([
      { type: 'system', content: 'native' }, { type: 'system', content: 'native addition' },
      { type: 'user', content: [{ type: 'text', text: '<user_info>\nWorkspace: fixture\n</user_info>' }] },
      { type: 'user', prompt_index: 0, content: [{ type: 'text', text: '<user_info>\nA user quotation\n</user_info>' }] },
    ])
    expect(document.entries[2]).toMatchObject({ kind: 'opaque', nativeType: 'grok.bootstrap' })
    expect(document.entries[3]).toMatchObject({ kind: 'message', role: 'user' })
  })
})

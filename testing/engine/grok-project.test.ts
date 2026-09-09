import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ConversationDocument } from '../../src/conversation/types.js'
import { decodeGrokConversation } from '../../src/grok/conversation/decode.js'
import { projectGrokArchive, projectGrokNativeResume } from '../../src/grok/project/project.js'

const records = readFileSync(new URL('../../fixtures/evidence/grok/command.jsonl', import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line))
const options = { targetSessionId: '11111111-1111-4111-8111-111111111111', now: '2026-09-08T12:00:00Z', cwd: '/workspace/target', model: 'grok-4.6' }

describe('Grok target projection', () => {
  it('preserves same-provider archive records once despite assistant/tool fan-out', () => {
    const archive = projectGrokArchive(decodeGrokConversation(records), options)
    expect(archive.profile).toBe('archive')
    expect(archive.values).toEqual(records)
    expect(archive.values[0]).not.toBe(records[0])
  })

  it('emits native history plus separate discovery metadata without foreign system instructions', () => {
    const conversation = decodeGrokConversation(records)
    const before = JSON.stringify(conversation)
    const result = projectGrokNativeResume(conversation, options)
    expect(result.profile).toBe('native-resume')
    expect(result.summary).toMatchObject({ info: { id: options.targetSessionId, cwd: options.cwd }, chat_format_version: 1, current_model_id: options.model })
    expect(result.summary.num_messages).toBe(0)
    expect(result.summary.num_chat_messages).toBe(result.values.length)
    expect(result.values.some(value => value.type === 'system')).toBe(false)
    expect(JSON.stringify(result.values)).not.toContain('Runtime reminder omitted')
    const projected = decodeGrokConversation(result.values)
    expect(projected.entries.filter(entry => entry.kind === 'tool-call')).toHaveLength(1)
    expect(projected.entries.filter(entry => entry.kind === 'tool-result')).toHaveLength(1)
    expect(projected.entries.find(entry => entry.kind === 'message' && entry.role === 'user')).toMatchObject({ content: [{ kind: 'text', text: 'Run this exact shell command: touch PERMISSION_PROBE.txt' }] })
    expect(JSON.stringify(conversation)).toBe(before)
    expect(result.report.counts.dropped).toBe(3)
  })

  it('never carries foreign encrypted reasoning into Grok', () => {
    const source = { provider: 'codex', line: 0, raw: {}, evidence: [] }
    const conversation: ConversationDocument = { schemaVersion: 1, sourceProvider: 'codex', sourceSessionIds: [], entries: [
      { kind: 'reasoning', text: 'The useful reasoning summary', encrypted: 'foreign-ciphertext', timestamp: null, source },
    ] }
    const result = projectGrokNativeResume(conversation, options)
    expect(JSON.stringify(result.values)).not.toContain('foreign-ciphertext')
    expect(JSON.stringify(result.values)).toContain('The useful reasoning summary')
    expect(result.values.some(value => value.type === 'reasoning')).toBe(false)
    expect(result.report.counts.demoted).toBe(1)
  })

  it('reports and removes incomplete native tool plumbing rather than fabricating results', () => {
    const conversation = decodeGrokConversation(records.filter(record => record.type !== 'tool_result'))
    const result = projectGrokNativeResume(conversation, options)
    expect(result.values.some(value => value.type === 'tool_result')).toBe(false)
    expect(result.values.some(value => Array.isArray(value.tool_calls) && value.tool_calls.length)).toBe(false)
    expect(result.report.changes).toContainEqual(expect.objectContaining({ code: 'native-resume.tool.unmatched-dropped', kind: 'dropped' }))
  })

  it('does not allow native tool pairs to cross a new user request', () => {
    const conversation = decodeGrokConversation(records)
    const resultIndex = conversation.entries.findIndex(entry => entry.kind === 'tool-result')
    conversation.entries.splice(resultIndex, 0, { kind: 'message', role: 'user', content: [{ kind: 'text', text: 'Stop that task' }], timestamp: null, source: { provider: 'grok', line: 20, raw: {}, evidence: [] } })
    const result = projectGrokNativeResume(conversation, options)
    expect(result.values.some(value => value.type === 'tool_result')).toBe(false)
    expect(result.report.changes.filter(change => change.code === 'native-resume.tool.cross-boundary-dropped')).toHaveLength(2)
  })

  it('preserves summary semantics without forging a target-native compaction event', () => {
    const source = { provider: 'claude', line: 0, raw: {}, evidence: [] }
    const conversation: ConversationDocument = { schemaVersion: 1, sourceProvider: 'claude', sourceSessionIds: [], entries: [
      { kind: 'compaction', summary: 'Completed the migration; remaining task is the UI.', summarySource: 'carrier', timestamp: null, source },
    ] }
    const result = projectGrokNativeResume(conversation, options)
    expect(result.values).toEqual([{ type: 'user', synthetic_reason: 'compaction_meta', content: [{ type: 'text', text: '[Previous conversation summary]\nCompleted the migration; remaining task is the UI.' }] }])
    expect(result.report.counts.demoted).toBe(1)
  })

  it('refuses invalid target identity before producing a native file set', () => {
    expect(() => projectGrokNativeResume(decodeGrokConversation(records), { ...options, targetSessionId: '../../escape' })).toThrow(/UUID/)
  })

  it('does not restore trimmed reasoning text from raw provenance during native projection', () => {
    const conversation = decodeGrokConversation(records)
    const reasoning = conversation.entries.find(entry => entry.kind === 'reasoning')!
    if (reasoning.kind !== 'reasoning') throw new Error('Missing recorded reasoning')
    reasoning.text = 'Trimmed reasoning'
    const result = projectGrokNativeResume(conversation, options)
    expect(JSON.stringify(result.values)).not.toContain('The user wants me to run an exact shell command')
    expect(JSON.stringify(result.values)).toContain('Trimmed reasoning')
  })

  it('does not discard foreign entries inside a mixed-source Grok archive', () => {
    const conversation = decodeGrokConversation(records)
    conversation.entries.push({ kind: 'message', role: 'user', content: [{ kind: 'text', text: 'Additional user context' }], timestamp: null, source: { provider: 'claude', line: 20, raw: { content: 'Additional user context' }, evidence: [] } })
    const values = projectGrokArchive(conversation, options).values
    expect(JSON.stringify(values)).toContain('Additional user context')
    const reasoning = values.find(value => value.type === 'reasoning')!
    expect(reasoning.atp_archive).toMatchObject({ source_omitted: true })
    expect((reasoning.atp_archive as Record<string, unknown>).source).toBeUndefined()
  })

  it('does not turn a text tool-result block with a URL attribute into an image', () => {
    const conversation = decodeGrokConversation(records)
    const result = conversation.entries.find(entry => entry.kind === 'tool-result')!
    if (result.kind !== 'tool-result') throw new Error('Missing recorded result')
    result.output = [{ type: 'text', text: 'Useful documentation', url: 'https://example.invalid/docs' }]
    const projected = projectGrokNativeResume(conversation, options).values.find(value => value.type === 'tool_result')!
    expect(projected.content).toBe('Useful documentation')
    expect(projected.images).toBeUndefined()
  })

  it('preserves archive provenance when all message content is unsupported natively', () => {
    const raw = { content: [{ type: 'future_content', important: 'retained archive evidence' }] }
    const conversation: ConversationDocument = { schemaVersion: 1, sourceProvider: 'future-provider', sourceSessionIds: [], entries: [
      { kind: 'message', role: 'user', content: [{ kind: 'opaque', nativeType: 'future_content', value: raw.content[0] }], timestamp: null, source: { provider: 'future-provider', line: 0, raw, evidence: [] } },
    ] }
    const archive = projectGrokArchive(conversation, options)
    expect(archive.values).toHaveLength(1)
    expect(archive.values[0]!.type).toBe('atp_archive')
    expect(archive.values[0]!.atp_archive).toBeUndefined()
    expect(JSON.stringify(archive.values)).toContain('retained archive evidence')
  })

  it('does not merge independent records from different sessions merely because line numbers match', () => {
    const conversation: ConversationDocument = { schemaVersion: 1, sourceProvider: 'grok', sourceSessionIds: ['a', 'b'], entries: [
      { kind: 'message', role: 'assistant', content: [{ kind: 'text', text: 'From session A' }], timestamp: null, source: { provider: 'grok', line: 0, raw: { type: 'assistant', content: 'From session A' }, evidence: [] } },
      { kind: 'tool-call', callId: 'call-b', name: 'read_file', input: { path: 'b.txt' }, nativeKind: 'function_call', timestamp: null, source: { provider: 'grok', line: 0, raw: { type: 'assistant', content: '', tool_calls: [] }, evidence: [] } },
      { kind: 'tool-result', callId: 'call-b', output: 'B', isError: null, nativeKind: 'tool_result', timestamp: null, source: { provider: 'grok', line: 1, raw: {}, evidence: [] } },
    ] }
    const projected = projectGrokNativeResume(conversation, options)
    expect(projected.values[0]).toEqual({ type: 'assistant', content: 'From session A' })
    expect(projected.values[1]).toMatchObject({ type: 'assistant', tool_calls: [{ name: 'read_file' }] })
    expect(JSON.stringify(projectGrokArchive(conversation, options).values)).toContain('read_file')
  })

  it('groups two calls from the same decoded record and retains both result pairs', () => {
    const source = [
      { type: 'assistant', content: 'Read both', tool_calls: [{ id: 'a', name: 'read_file', arguments: '{"path":"a"}' }, { id: 'b', name: 'read_file', arguments: '{"path":"b"}' }] },
      { type: 'tool_result', tool_call_id: 'a', content: 'A' },
      { type: 'tool_result', tool_call_id: 'b', content: 'B' },
    ]
    const conversation = decodeGrokConversation(source)
    const result = projectGrokNativeResume(conversation, options)
    expect(result.values).toHaveLength(3)
    expect(result.values[0]).toMatchObject({ content: 'Read both', tool_calls: [{ id: 'a' }, { id: 'b' }] })
    expect(projectGrokArchive(conversation, options).values).toEqual(source)
  })

  it('remaps a duplicate call id and its paired result consistently', () => {
    const conversation = decodeGrokConversation([
      { type: 'assistant', content: '', tool_calls: [{ id: 'same', name: 'read_file', arguments: '{}' }] },
      { type: 'tool_result', tool_call_id: 'same', content: 'first' },
      { type: 'assistant', content: '', tool_calls: [{ id: 'same', name: 'read_file', arguments: '{}' }] },
      { type: 'tool_result', tool_call_id: 'same', content: 'second' },
    ])
    const result = projectGrokNativeResume(conversation, options)
    const calls = result.values.filter(value => value.type === 'assistant').map(value => (value.tool_calls as Array<{ id: string }>)[0]!.id)
    expect(calls[0]).not.toBe(calls[1])
    expect(result.values.filter(value => value.type === 'tool_result').map(value => value.tool_call_id)).toEqual(calls)
    expect(result.report.counts.repaired).toBe(1)
  })

  it('does not accumulate imported-context labels on repeated Grok projection', () => {
    let conversation = decodeGrokConversation([{ type: 'user', synthetic_reason: 'compaction_meta', content: [{ type: 'text', text: 'Retained task state.' }] }])
    const first = projectGrokNativeResume(conversation, options)
    for (let count = 0; count < 4; count++) conversation = decodeGrokConversation(projectGrokNativeResume(conversation, options).values)
    expect(projectGrokNativeResume(conversation, options).values).toEqual(first.values)
  })

  it('preserves a native tool-result image through the neutral representation', () => {
    const source = [
      { type: 'assistant', content: '', tool_calls: [{ id: 'image-call', name: 'read_file', arguments: '{}' }] },
      { type: 'tool_result', tool_call_id: 'image-call', content: 'image result', images: [{ type: 'image', url: 'https://example.invalid/result.png' }] },
    ]
    const conversation = decodeGrokConversation(source)
    expect(conversation.entries.find(entry => entry.kind === 'tool-result')).toMatchObject({ output: [
      { type: 'text', text: 'image result' }, { type: 'image', source: { type: 'url', url: 'https://example.invalid/result.png' } },
    ] })
    expect(projectGrokNativeResume(conversation, options).values[1]).toEqual(source[1])
  })
})

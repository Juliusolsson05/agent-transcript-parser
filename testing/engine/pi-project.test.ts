import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ConversationDocument, ConversationEntry } from '../../src/conversation/types.js'
import { decodePiConversation } from '../../src/pi/conversation/decode.js'
import { piSessionFileName, projectPiArchive, projectPiNativeResume } from '../../src/pi/project/project.js'
import { conversationAfterLatestPortableCompaction, describeLatestCompaction } from '../../src/operations/compaction.js'

// The Pi target over Stage 0 recordings of pi 0.87.1. The contract for the
// native file is Pi's own loader: header, then a parentId chain from the last
// row (session-manager.ts buildSessionPath). So most assertions re-read the
// projection as Pi would, with the same decoder, and check what the model
// would receive.

type Row = Record<string, any>
const load = (name: string): Row[] =>
  readFileSync(new URL(`../../fixtures/evidence/pi/${name}.jsonl`, import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line))
const options = { targetSessionId: '019a0000-0000-7000-8000-000000000001', now: '2026-09-23T10:00:00.000Z', cwd: '/workspace/target' }
const src = (provider: string, line: number, raw: Record<string, unknown> = {}) => ({ provider, line, raw, evidence: [] })
const semantic = (entries: ConversationEntry[]) => entries.filter(entry => entry.kind !== 'opaque')
  .map(({ source: _source, timestamp: _timestamp, ...rest }) => rest)

function expectValidPiFile(values: Record<string, unknown>[]) {
  expect(values[0]).toEqual({ type: 'session', version: 3, id: options.targetSessionId, timestamp: options.now, cwd: options.cwd })
  const rows = values.slice(1)
  const ids = rows.map(row => row.id as string)
  for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}$/)
  expect(new Set(ids).size).toBe(ids.length)
  // A linear chain: Pi's branch from the last row reaches every row.
  rows.forEach((row, index) => expect(row.parentId).toBe(index === 0 ? null : ids[index - 1]))
  for (const row of rows) expect(Number.isFinite(Date.parse(row.timestamp as string))).toBe(true)
}

describe('Pi target projection', () => {
  it('a Pi conversation projects to a valid v3 file that decodes back to the same conversation', () => {
    for (const name of ['tool', 'tree', 'compaction', 'user-bash', 'abort']) {
      const source = decodePiConversation(load(name))
      const before = JSON.stringify(source)
      const result = projectPiNativeResume(source, options)
      expectValidPiFile(result.values)
      expect(semantic(decodePiConversation(result.values).entries)).toEqual(semantic(source.entries))
      expect(JSON.stringify(source)).toBe(before)
    }
  })

  it('unchanged Pi rows keep their native identity: model, usage, tool details, bash rows', () => {
    const rows = load('tool')
    const values = projectPiNativeResume(decodePiConversation(rows), options).values
    const assistants = values.filter(row => row.type === 'message' && (row.message as Row).role === 'assistant').map(row => row.message as Row)
    expect(assistants.map(message => message.provider)).toEqual(['faux', 'faux', 'faux', 'faux'])
    const recordedCall = rows.find(row => row.message?.stopReason === 'toolUse')!.message
    expect(assistants[0]).toEqual(recordedCall)
    const result = values.find(row => (row.message as Row | undefined)?.role === 'toolResult')!.message as Row
    expect(result).toMatchObject({ toolName: 'bash', toolCallId: recordedCall.content[2].id, isError: false })
    const bash = projectPiNativeResume(decodePiConversation(load('user-bash')), options).values.find(row => (row.message as Row | undefined)?.role === 'bashExecution')
    expect(bash).toMatchObject({ message: { command: 'echo from-user-bash', exitCode: 0 } })
    // The origin marker is extension state Pi never sends to a model.
    expect(values[1]).toMatchObject({ type: 'custom', customType: 'agent-code.import', data: { sourceProvider: 'pi', sourceSessionIds: [rows[0]!.id] } })
  })

  it('only the active branch is written; its branch summary still resolves', () => {
    const rows = load('tree')
    const values = projectPiNativeResume(decodePiConversation(rows), options).values
    const summary = values.find(row => row.type === 'branch_summary')!
    expect(summary.fromId).toBe(summary.parentId)
    const users = values.filter(row => (row.message as Row | undefined)?.role === 'user').map(row => (row.message as Row).content[0].text)
    expect(users).toEqual(['first [probe:t1]branch c [probe:t4]'])
  })

  it('a compaction stays a native, portable boundary; the kept rows follow it', () => {
    const values = projectPiNativeResume(decodePiConversation(load('compaction')), options).values
    const compaction = values.find(row => row.type === 'compaction')!
    // Pi's own "keep nothing before me" (appendCompaction `?? id`).
    expect(compaction.firstKeptEntryId).toBe(compaction.id)
    const reread = decodePiConversation(values)
    expect(describeLatestCompaction(reread)!.availability).toBe('portable')
    const after = conversationAfterLatestPortableCompaction(reread).entries
    expect(after.filter(entry => entry.kind === 'message').map(entry => (entry as Row).content[0].text))
      .toEqual(['Reply to a 16-character prompt.', 'after compaction [probe:c4]', expect.stringMatching(/^Reply to/)])
  })

  it('a foreign assistant turn is imported under an honest non-Pi identity with zero usage, never a forged signature', () => {
    const conversation: ConversationDocument = { schemaVersion: 1, sourceProvider: 'claude', sourceSessionIds: ['s'], entries: [
      { kind: 'message', role: 'system', content: [{ kind: 'text', text: 'You are Claude Code.' }], timestamp: null, source: src('claude', 0) },
      { kind: 'message', role: 'user', content: [{ kind: 'text', text: 'Read the file.' }], timestamp: '2026-09-01T00:00:00.000Z', source: src('claude', 1) },
      { kind: 'reasoning', text: 'I will read it.', encrypted: 'claude-signature', timestamp: null, source: src('claude', 2) },
      { kind: 'reasoning', text: '', encrypted: 'opaque-ciphertext', timestamp: null, source: src('claude', 3) },
      { kind: 'message', role: 'assistant', content: [{ kind: 'text', text: 'Reading.' }], timestamp: null, source: src('claude', 4) },
      { kind: 'tool-call', callId: 'toolu_1', name: 'Read', input: { path: 'a' }, nativeKind: 'tool_use', timestamp: null, source: src('claude', 5) },
      { kind: 'tool-result', callId: 'toolu_1', output: 'contents', isError: false, nativeKind: 'tool_result', timestamp: null, source: src('claude', 6) },
      { kind: 'message', role: 'assistant', content: [{ kind: 'text', text: 'Done.' }], timestamp: null, source: src('claude', 7) },
    ] }
    const result = projectPiNativeResume(conversation, options)
    expectValidPiFile(result.values)
    const text = JSON.stringify(result.values)
    expect(text).not.toContain('claude-signature')
    expect(text).not.toContain('opaque-ciphertext')
    const messages = result.values.filter(row => row.type === 'message').map(row => row.message as Row)
    expect(messages.map(message => message.role)).toEqual(['user', 'assistant', 'toolResult', 'assistant'])
    // Four Claude records, one model response in Pi.
    expect(messages[1]).toMatchObject({
      api: 'agent-code-import', provider: 'agent-code-import', model: 'imported', stopReason: 'toolUse',
      usage: { totalTokens: 0, cost: { total: 0 } },
      content: [{ type: 'thinking', thinking: 'I will read it.' }, { type: 'text', text: 'Reading.' }, { type: 'toolCall', id: 'toolu_1', name: 'Read', arguments: { path: 'a' } }],
    })
    expect(messages[2]).toMatchObject({ toolCallId: 'toolu_1', toolName: 'Read', content: [{ type: 'text', text: 'contents' }], isError: false })
    expect(messages[3]).toMatchObject({ stopReason: 'stop', content: [{ type: 'text', text: 'Done.' }] })
    // Claude's system prompt is labelled context, never Pi's system prompt.
    expect(result.values.find(row => row.type === 'custom_message')).toMatchObject({
      customType: 'agent-code.imported-context', display: true, content: [{ type: 'text', text: '[Imported system context]' }, { type: 'text', text: 'You are Claude Code.' }],
    })
    expect(messages.some(message => message.role === 'system')).toBe(false)
    expect(result.report.changes).toContainEqual(expect.objectContaining({ code: 'native-resume.reasoning.encrypted-dropped' }))
  })

  it('an edited Pi reply loses its native model identity (its signatures no longer match it)', () => {
    const conversation = decodePiConversation(load('tool'))
    const text = conversation.entries.find(entry => entry.kind === 'message' && entry.role === 'assistant')!
    ;(text as Row).content = [{ kind: 'text', text: 'Edited.' }]
    const assistant = projectPiNativeResume(conversation, options).values.find(row => (row.message as Row | undefined)?.role === 'assistant')!.message as Row
    expect(assistant).toMatchObject({ provider: 'agent-code-import', content: [{ type: 'thinking' }, { type: 'text', text: 'Edited.' }, { type: 'toolCall' }] })
  })

  it('drops incomplete and boundary-crossing tool plumbing instead of inventing results', () => {
    // Removed from the DOCUMENT: removing rows from the file would cut Pi's
    // parent chain instead of leaving calls unanswered.
    const conversation = decodePiConversation(load('tool'))
    conversation.entries = conversation.entries.filter(entry => entry.kind !== 'tool-result')
    const result = projectPiNativeResume(conversation, options)
    expect(JSON.stringify(result.values)).not.toContain('"toolCall"')
    expect(result.report.changes.filter(change => change.code === 'native-resume.tool.unmatched-dropped')).toHaveLength(2)

    const crossing = decodePiConversation(load('tool'))
    const resultIndex = crossing.entries.findIndex(entry => entry.kind === 'tool-result')
    crossing.entries.splice(resultIndex, 0, { kind: 'message', role: 'user', content: [{ kind: 'text', text: 'Stop.' }], timestamp: null, source: src('pi', 99) })
    const crossed = projectPiNativeResume(crossing, options)
    expect(crossed.report.changes.filter(change => change.code === 'native-resume.tool.cross-boundary-dropped')).toHaveLength(2)
  })

  it('images: inline data survives in Pi’s base64 shape; a remote URL has no Pi form and is reported', () => {
    const conversation: ConversationDocument = { schemaVersion: 1, sourceProvider: 'grok', sourceSessionIds: [], entries: [
      { kind: 'message', role: 'user', content: [
        { kind: 'text', text: 'see' },
        { kind: 'image', value: { type: 'image', source: { type: 'url', url: 'data:image/png;base64,iVBORw0KGgo=' } } },
        { kind: 'image', value: { type: 'image', source: { type: 'url', url: 'https://example.invalid/x.png' } } },
      ], timestamp: null, source: src('grok', 0) },
    ] }
    const result = projectPiNativeResume(conversation, options)
    expect(result.values.find(row => row.type === 'message')).toMatchObject({ message: { content: [{ type: 'text', text: 'see' }, { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }] } })
    expect(result.report.changes).toContainEqual(expect.objectContaining({ code: 'native-resume.content.image.dropped' }))
  })

  it('a v2 hookMessage is written under its v3 name, or Pi would silently drop it from context', () => {
    const values = projectPiNativeResume(decodePiConversation(load('v2-hook-message')), options).values
    const roles = values.filter(row => row.type === 'message').map(row => (row.message as Row).role)
    expect(roles).toContain('custom')
    expect(roles).not.toContain('hookMessage')
  })

  it('refuses a session id Pi would refuse, and names the file the way Pi does', () => {
    expect(() => projectPiNativeResume(decodePiConversation(load('tool')), { ...options, targetSessionId: '../escape' })).toThrow(/session id/)
    expect(projectPiNativeResume(decodePiConversation(load('tool')), options).fileName).toBe(`2026-09-23T10-00-00-000Z_${options.targetSessionId}.jsonl`)
    expect(piSessionFileName('abc', '2026-09-23T00:03:15.310Z')).toBe('2026-09-23T00-03-15-310Z_abc.jsonl')
  })
})

describe('Pi archive projection', () => {
  it('same-provider archive re-emits the active branch rows once, in file order, untouched', () => {
    const rows = load('compaction')
    const archive = projectPiArchive(decodePiConversation(rows), options)
    expect(archive.values).toEqual(rows)
    const tree = load('tree')
    const branchArchive = projectPiArchive(decodePiConversation(tree), options).values
    // Abandoned rows are not part of this conversation.
    expect(branchArchive.length).toBeLessThan(tree.length)
    expect(branchArchive.every(row => tree.some(original => JSON.stringify(original) === JSON.stringify(row)))).toBe(true)
  })

  it('a foreign archive keeps opaque evidence as extension state with provenance', () => {
    const conversation: ConversationDocument = { schemaVersion: 1, sourceProvider: 'codex', sourceSessionIds: [], entries: [
      { kind: 'opaque', nativeType: 'turn_context', timestamp: null, source: src('codex', 0, { type: 'turn_context', model: 'gpt' }) },
      { kind: 'message', role: 'user', content: [{ kind: 'text', text: 'hi' }], timestamp: null, source: src('codex', 1, { type: 'response_item' }) },
    ] }
    const values = projectPiArchive(conversation, options).values
    expect(values[2]).toMatchObject({ type: 'custom', customType: 'atp_archive' })
    expect(values[3]).toMatchObject({ type: 'message', message: { role: 'user' }, atp_archive: expect.any(Object) })
  })
})

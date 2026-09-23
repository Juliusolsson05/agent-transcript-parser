import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ConversationEntry } from '../../src/conversation/types.js'
import { decodePiConversation } from '../../src/pi/conversation/decode.js'
import { conversationAfterLatestPortableCompaction, describeLatestCompaction } from '../../src/operations/compaction.js'

// Every file here is a Stage 0 recording of the real pi 0.87.1 (faux provider)
// or a durable v1/v2 shape from the Pi census. Expectations are read off the
// recorded rows with an independent parentId walk below, never from the
// decoder, so a decoder that walks the file in line order fails them.

type Row = Record<string, any>
const load = (name: string): Row[] =>
  readFileSync(new URL(`../../fixtures/evidence/pi/${name}.jsonl`, import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line))

/** The branch Pi loads: parentId chain from the last row. Test-local on purpose. */
function referenceBranch(rows: Row[]): Row[] {
  const byId = new Map(rows.filter(row => row.type !== 'session').map(row => [row.id, row]))
  const out: Row[] = []
  for (let cursor = rows.at(-1); cursor && cursor.type !== 'session'; cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined) out.push(cursor)
  return out.reverse()
}
const textOf = (row: Row) => (row.message.content as Row[]).filter(block => block.type === 'text').map(block => block.text).join('')
const messageTexts = (entries: ConversationEntry[], role: string) =>
  entries.filter(entry => entry.kind === 'message' && entry.role === role)
    .map(entry => (entry as Extract<ConversationEntry, { kind: 'message' }>).content.map(part => part.kind === 'text' ? part.text : '').join(''))

describe('recorded Pi conversation semantics', () => {
  it('decodes the active branch only — an abandoned /tree turn never becomes history', () => {
    const rows = load('tree')
    const document = decodePiConversation(rows)
    const branch = referenceBranch(rows)
    expect(document.sourceProvider).toBe('pi')
    expect(document.sourceSessionIds).toEqual([rows[0]!.id])
    const users = branch.filter(row => row.type === 'message' && row.message.role === 'user').map(textOf)
    // The typed prompts (the branch summary is user-role context too, below).
    expect(messageTexts(document.entries.filter(entry => entry.source.raw.type === 'message'), 'user')).toEqual(users)
    // Compared by ROW, not by text: the forked prompt on this branch starts
    // with the abandoned first prompt's text (Pi puts it back in the editor).
    const abandoned = rows.filter(row => row.type !== 'session' && !branch.includes(row))
    expect(abandoned.some(row => row.message?.role === 'user')).toBe(true)
    expect(document.entries.filter(entry => abandoned.includes(entry.source.raw))).toEqual([])
    // The branch summary Pi wrote when leaving the other branch is context the
    // model receives, with Pi's exact wrapper (0.87.1 dist messages.js
    // BRANCH_SUMMARY_*; main's source has one newline less).
    const summaryRow = branch.find(row => row.type === 'branch_summary')!
    expect(document.entries).toContainEqual(expect.objectContaining({
      kind: 'message', role: 'user',
      content: [{ kind: 'text', text: `The following is a summary of a branch that this conversation came back from:\n\n<summary>\n${summaryRow.summary}</summary>` }],
    }))
  })

  it('source lines are physical file lines, so rewind/paging can address the row', () => {
    const rows = load('tree')
    const document = decodePiConversation(rows)
    for (const entry of document.entries) expect(entry.source.raw).toBe(rows[entry.source.line])
  })

  it('an explicit leaf (a live /tree move that wrote no row) selects that branch instead of the last row', () => {
    const rows = load('tree')
    // The first branch's last assistant reply: second [probe:t2]'s answer.
    const secondUser = rows.find(row => row.type === 'message' && row.message.role === 'user' && textOf(row) === 'second [probe:t2]')!
    const leaf = rows.find(row => row.parentId === secondUser.id)!
    const document = decodePiConversation(rows, { leafId: leaf.id })
    expect(messageTexts(document.entries, 'user')).toEqual(['first [probe:t1]', 'second [probe:t2]'])
    expect(() => decodePiConversation(rows, { leafId: 'not-in-file' })).toThrow(/leaf/)
  })

  it('an assistant reply keeps Pi’s block order: reasoning, text, tool call; the result threads by id', () => {
    const rows = load('tool')
    const document = decodePiConversation(rows)
    const callRow = rows.find(row => row.message?.stopReason === 'toolUse')!
    const fromCallRow = document.entries.filter(entry => entry.source.raw === callRow)
    expect(fromCallRow.map(entry => entry.kind)).toEqual(['reasoning', 'message', 'tool-call'])
    const call = callRow.message.content.find((block: Row) => block.type === 'toolCall')
    expect(fromCallRow[2]).toMatchObject({ kind: 'tool-call', callId: call.id, name: 'bash', input: call.arguments, nativeKind: 'toolCall' })
    expect(fromCallRow[0]).toMatchObject({ kind: 'reasoning', text: 'I should run a command.', encrypted: null })
    const result = document.entries.find(entry => entry.kind === 'tool-result')
    expect(result).toMatchObject({ callId: call.id, output: 'probe-tool-output\n', isError: false, nativeKind: 'toolResult' })
    // Row timestamps are Pi's own ISO stamps.
    expect(fromCallRow[0]!.timestamp).toBe(callRow.timestamp)
  })

  it('aborted and errored replies are opaque: Pi never replays them, so no target may treat them as answers', () => {
    const aborted = decodePiConversation(load('abort'))
    expect(aborted.entries.filter(entry => entry.kind === 'opaque' && entry.nativeType === 'pi.assistant.aborted')).toHaveLength(2)
    expect(messageTexts(aborted.entries, 'assistant')).toEqual(['Reply to a 17-character prompt.'])
    expect(aborted.entries.some(entry => entry.kind === 'reasoning')).toBe(false)
    const errored = decodePiConversation(load('error'))
    expect(errored.entries.some(entry => entry.kind === 'opaque' && entry.nativeType === 'pi.assistant.error')).toBe(true)
    expect(messageTexts(errored.entries, 'assistant').every(text => text.length > 0)).toBe(true)
  })

  it('the user’s !bash run reaches the model as the exact text Pi sends (bashExecutionToText)', () => {
    const rows = load('user-bash')
    const document = decodePiConversation(rows)
    const bash = document.entries.find(entry => entry.source.raw.message?.role === 'bashExecution')
    expect(bash).toMatchObject({ kind: 'message', role: 'user', content: [{ kind: 'text', text: 'Ran `echo from-user-bash`\n```\nfrom-user-bash\n\n```' }] })
    // `!!cmd` is excluded from context in Pi; it must not reappear elsewhere.
    const excluded = rows.map(row => row.message?.role === 'bashExecution' ? { ...row, message: { ...row.message, excludeFromContext: true } } : row)
    expect(decodePiConversation(excluded).entries.find(entry => entry.source.line === bash!.source.line)).toMatchObject({ kind: 'opaque', nativeType: 'pi.bashExecution.excluded' })
    // Non-zero exits and cancellation carry Pi's own suffixes.
    const failed = rows.map(row => row.message?.role === 'bashExecution' ? { ...row, message: { ...row.message, output: '', exitCode: 2 } } : row)
    expect(decodePiConversation(failed).entries.find(entry => entry.source.line === bash!.source.line))
      .toMatchObject({ content: [{ kind: 'text', text: 'Ran `echo from-user-bash`\n(no output)\n\nCommand exited with code 2' }] })
  })

  it('places the compaction before the entries it keeps, so the neutral slice keeps exactly Pi’s context', () => {
    const rows = load('compaction')
    const document = decodePiConversation(rows)
    const compactionRow = rows.find(row => row.type === 'compaction')!
    const latest = describeLatestCompaction(document)!
    expect(latest.entry).toMatchObject({ kind: 'compaction', summary: compactionRow.summary, summarySource: 'carrier' })
    expect(latest.availability).toBe('portable')
    // Pi's context after this compaction (session-manager.ts buildContextEntries):
    // the summary, the kept range firstKeptEntryId..compaction, then later rows.
    const branch = referenceBranch(rows)
    const compactionIndex = branch.indexOf(compactionRow)
    const kept = branch.slice(branch.findIndex(row => row.id === compactionRow.firstKeptEntryId), compactionIndex)
    const expectedLines = [...kept, ...branch.slice(compactionIndex + 1)]
      .filter(row => row.type === 'message' && row.message.role !== 'system').map(row => rows.indexOf(row))
    const after = conversationAfterLatestPortableCompaction(document)
    expect(after.entries[0]!.kind).toBe('compaction')
    expect([...new Set(after.entries.slice(1).map(entry => entry.source.line))]).toEqual(expectedLines)
    // The summarized turns are still in the document, before the boundary.
    expect(messageTexts(document.entries, 'user')).toEqual(['one [probe:c1]', 'two [probe:c2]', 'three [probe:c3]', 'after compaction [probe:c4]'])
  })

  it('an older compaction inside the kept range contributes nothing, as in Pi', () => {
    const rows = load('compaction')
    const compaction = rows.find(row => row.type === 'compaction')!
    // A second compaction whose kept range starts before the first one.
    const tail = rows.at(-1)!
    const second = { ...compaction, id: 'c0ffee00', parentId: tail.id, summary: 'Newer summary', firstKeptEntryId: rows[4]!.id, timestamp: '2026-09-23T00:03:18.000Z' }
    const document = decodePiConversation([...rows, second])
    expect(document.entries.filter(entry => entry.kind === 'compaction').map(entry => (entry as { summary: string }).summary)).toEqual(['Newer summary'])
    expect(document.entries).toContainEqual(expect.objectContaining({ kind: 'opaque', nativeType: 'pi.compaction.superseded' }))
  })

  it('a v1 compaction keeps the rows its firstKeptEntryIndex names, as Pi’s own migration resolves it', () => {
    const header = { type: 'session', id: 'v1c', timestamp: '2025-11-20T00:00:00.000Z', cwd: '/p' }
    const user = (text: string) => ({ type: 'message', timestamp: '2025-11-20T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text }] } })
    const reply = (text: string) => ({ type: 'message', timestamp: '2025-11-20T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' } })
    // entries[3] (header at 0) is the kept prompt: migrateV1ToV2 turns the
    // index into that entry's id, and buildContextEntries re-sends from there.
    const rows = [header, user('old prompt'), reply('old reply'), user('kept prompt'), reply('kept reply'),
      { type: 'compaction', timestamp: '2025-11-20T00:00:03.000Z', summary: 'S', firstKeptEntryIndex: 3, tokensBefore: 10 }, user('after prompt')]
    const after = conversationAfterLatestPortableCompaction(decodePiConversation(rows))
    expect(messageTexts(after.entries, 'user')).toEqual(['kept prompt', 'after prompt'])
    expect(messageTexts(after.entries, 'assistant')).toEqual(['kept reply'])
  })

  it('an in-context edit that targets a summarized row changes nothing, because Pi never sends that row', () => {
    const rows = load('compaction')
    const firstUser = rows.find(row => row.message?.role === 'user')!
    const edit = { type: 'context_edit', id: 'e0000009', parentId: rows.at(-1)!.id, timestamp: rows.at(-1)!.timestamp, targetId: firstUser.id, replacement: null }
    const document = decodePiConversation([...rows, edit])
    expect(document.entries.find(entry => entry.source.raw === firstUser)).toMatchObject({ kind: 'message', role: 'user' })
  })

  it('Pi’s own system prompt snapshot and bookkeeping rows are opaque evidence, never speech', () => {
    const document = decodePiConversation(load('tool'))
    const opaqueTypes = document.entries.filter(entry => entry.kind === 'opaque').map(entry => (entry as { nativeType: string }).nativeType)
    expect(opaqueTypes).toEqual(['pi.session', 'pi.model_change', 'pi.thinking_level_change', 'pi.system'])
    expect(document.entries.some(entry => entry.kind === 'message' && entry.role === 'system')).toBe(false)
  })

  it('context_edit replaces or removes its target the way Pi projects it', () => {
    const rows = load('tool')
    const reply = rows.at(-1)!
    const result = rows.find(row => row.message?.role === 'toolResult')!
    const edits = [
      { type: 'context_edit', id: 'e0000001', parentId: reply.id, timestamp: reply.timestamp, targetId: result.id, replacement: { content: 'trimmed output' } },
      { type: 'context_edit', id: 'e0000002', parentId: 'e0000001', timestamp: reply.timestamp, targetId: rows[4]!.id, replacement: null },
    ]
    const document = decodePiConversation([...rows, ...edits])
    expect(document.entries.find(entry => entry.source.raw === result)).toMatchObject({ kind: 'tool-result', output: 'trimmed output' })
    expect(document.entries.find(entry => entry.source.raw === rows[4])).toMatchObject({ kind: 'opaque', nativeType: 'pi.context-edit.removed' })
  })

  it('a context_edit inside a summarized range never applied, as in Pi', () => {
    const rows = load('compaction')
    const compaction = rows.find(row => row.type === 'compaction')!
    const firstUser = rows.find(row => row.message?.role === 'user')!
    // Splice an edit that removes the first prompt in just BEFORE the first
    // kept row: on the branch, but in the summarized range.
    const firstKept = rows.find(row => row.id === compaction.firstKeptEntryId)!
    const edit = { type: 'context_edit', id: 'e0000003', parentId: firstKept.parentId, timestamp: firstKept.timestamp, targetId: firstUser.id, replacement: null }
    const splice = (at: Row) => rows.flatMap(row => row === firstKept ? [at, { ...row, parentId: at.id }] : [row])
    const document = decodePiConversation(splice(edit))
    expect(document.entries.find(entry => entry.source.raw === firstUser)).toMatchObject({ kind: 'message', role: 'user' })
    // An edit in context that targets a KEPT row (one Pi re-sends) applies.
    const keptEdit = { ...edit, targetId: firstKept.id, parentId: compaction.parentId }
    const inContext = rows.flatMap(row => row === compaction ? [keptEdit, { ...row, parentId: keptEdit.id }] : [row])
    expect(decodePiConversation(inContext).entries.find(entry => entry.source.raw === firstKept)).toMatchObject({ kind: 'opaque', nativeType: 'pi.context-edit.removed' })
  })

  it('user images become the neutral base64 carrier', () => {
    const header = { type: 'session', version: 3, id: 'img', timestamp: '2026-09-23T00:00:00.000Z', cwd: '/sandbox/project' }
    const user = { type: 'message', id: 'aaaa0001', parentId: null, timestamp: '2026-09-23T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }], timestamp: 1 } }
    expect(decodePiConversation([header, user]).entries[1]).toMatchObject({
      kind: 'message', role: 'user',
      content: [{ kind: 'text', text: 'look' }, { kind: 'image', value: { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } } }],
    })
  })

  it('reads a pre-migration v1 file as the linear list it is, and a v2 hookMessage as extension context', () => {
    const v1 = decodePiConversation(load('v1-linear'))
    expect(v1.entries.map(entry => entry.kind)).toEqual(['opaque', 'message', 'opaque', 'opaque', 'message', 'message', 'tool-call', 'tool-result', 'opaque', 'message'])
    // The v1 file's empty first reply was an abort (stopReason 'aborted').
    expect(v1.entries[2]).toMatchObject({ kind: 'opaque', nativeType: 'pi.assistant.aborted' })
    const v2 = decodePiConversation(load('v2-hook-message'))
    expect(v2.entries.find(entry => entry.source.raw.message?.role === 'hookMessage')).toMatchObject({ kind: 'message', role: 'user', content: [{ kind: 'text' }] })
  })

  it('refuses a file that is not a Pi session instead of inventing one', () => {
    expect(() => decodePiConversation([{ type: 'message', message: { role: 'user', content: 'x' } }])).toThrow(/header/)
    expect(() => decodePiConversation([])).toThrow(/header/)
  })

  it('an empty completed reply is evidence, not an empty bubble', () => {
    const header = { type: 'session', version: 3, id: 'x', timestamp: '2026-09-23T00:00:00.000Z', cwd: '/p' }
    const empty = { type: 'message', id: 'cccc0001', parentId: null, timestamp: '2026-09-23T00:00:01.000Z', message: { role: 'assistant', content: [], stopReason: 'stop' } }
    expect(decodePiConversation([header, empty]).entries[1]).toMatchObject({ kind: 'opaque', nativeType: 'pi.empty-assistant' })
  })

  it('keeps unknown future rows as opaque evidence', () => {
    const header = { type: 'session', version: 3, id: 'x', timestamp: '2026-09-23T00:00:00.000Z', cwd: '/p' }
    const future = { type: 'future_row', id: 'bbbb0001', parentId: null, timestamp: '2026-09-23T00:00:01.000Z', data: 1 }
    expect(decodePiConversation([header, future]).entries[1]).toMatchObject({ kind: 'opaque', nativeType: 'pi.future_row' })
  })
})

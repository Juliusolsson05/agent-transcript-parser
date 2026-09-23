import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { classifyClaudeDocument } from '../../src/claude/classify/index.js'
import { classifyCodexDocument } from '../../src/codex/classify/index.js'
import { decodeClaudeConversation } from '../../src/claude/conversation/decode.js'
import { decodeCodexConversation } from '../../src/codex/conversation/decode.js'
import { projectClaudeNativeResume } from '../../src/claude/project/nativeResume.js'
import { projectCodexNativeResume } from '../../src/codex/project/nativeResume.js'
import { decodeOpencodeConversation } from '../../src/opencode/conversation/decode.js'
import { projectOpencodeNativeResume } from '../../src/opencode/project/nativeResume.js'
import { decodeGrokConversation } from '../../src/grok/conversation/decode.js'
import { projectGrokNativeResume } from '../../src/grok/project/project.js'
import { decodeJsonl, encodeJsonlValues } from '../../src/jsonl/index.js'
import type { ConversationDocument, ConversationEntry } from '../../src/conversation/types.js'
import { decodePiConversation } from '../../src/pi/conversation/decode.js'
import { projectPiNativeResume } from '../../src/pi/project/project.js'
import { conversationAfterLatestPortableCompaction } from '../../src/operations/compaction.js'

// Pi joins the neutral hub: its decoder feeds every existing projector, and
// every existing decoder feeds its projector. No pairwise converter exists or
// is needed. The source is a real pi 0.87.1 recording (faux provider).

type Row = Record<string, any>
const load = (name: string): Row[] =>
  readFileSync(new URL(`../../fixtures/evidence/pi/${name}.jsonl`, import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line))
const options = {
  targetSessionId: '11111111-1111-4111-8111-111111111111', now: '2026-09-23T12:00:00.000Z', cwd: '/workspace/target',
  model: 'test-model', version: '2.1.0', cliVersion: '1.0.13', modelProvider: 'test',
}
const targets: Array<[string, (conversation: ConversationDocument) => ConversationDocument]> = [
  ['claude', conversation => decodeClaudeConversation(classifyClaudeDocument(decodeJsonl(encodeJsonlValues(projectClaudeNativeResume(conversation, options).values))).records)],
  ['codex', conversation => decodeCodexConversation(classifyCodexDocument(decodeJsonl(encodeJsonlValues(projectCodexNativeResume(conversation, options).values))).records)],
  ['opencode', conversation => decodeOpencodeConversation(projectOpencodeNativeResume(conversation, options).values[0])],
  ['grok', conversation => decodeGrokConversation(projectGrokNativeResume(conversation, options).values)],
]
const userTexts = (entries: ConversationEntry[]) => entries.filter(entry => entry.kind === 'message' && entry.role === 'user')
  .map(entry => (entry as Extract<ConversationEntry, { kind: 'message' }>).content.map(part => part.kind === 'text' ? part.text : '').join(''))

describe('Pi through the neutral hub', () => {
  it.each(targets)('keeps the recorded requests and both bash tool cycles through %s and back into Pi', (_name, target) => {
    const source = decodePiConversation(load('tool'))
    const before = JSON.stringify(source)
    const back = projectPiNativeResume(target(source), options)
    const returned = decodePiConversation(back.values)
    expect(userTexts(returned.entries)).toEqual(['please [tool] now', 'and again [tool]'])
    const calls = returned.entries.filter(entry => entry.kind === 'tool-call')
    expect(calls.map(entry => (entry as { name: string }).name)).toEqual(['bash', 'bash'])
    expect(calls.map(entry => (entry as { input: unknown }).input)).toEqual([{ command: 'echo probe-tool-output' }, { command: 'echo probe-tool-output' }])
    const results = returned.entries.filter(entry => entry.kind === 'tool-result')
    expect(results.map(entry => (entry as { callId: string }).callId)).toEqual(calls.map(entry => (entry as { callId: string }).callId))
    expect(results.map(entry => (entry as { output: unknown }).output)).toEqual(['probe-tool-output\n', 'probe-tool-output\n'])
    // Pi's toolResult needs the tool's name; it came from the paired call.
    expect(back.values.filter(row => (row.message as Row | undefined)?.role === 'toolResult').map(row => (row.message as Row).toolName)).toEqual(['bash', 'bash'])
    expect(JSON.stringify(source)).toBe(before)
  })

  it.each(targets)('an abandoned /tree branch never reaches %s', (_name, target) => {
    const rows = load('tree')
    const foreign = target(decodePiConversation(rows))
    // Only the recorded prompts: OpenCode's projector demotes the branch
    // summary into a labelled user turn, which is that target's own rule.
    expect(userTexts(foreign.entries).filter(text => text.includes('[probe:'))).toEqual(['first [probe:t1]branch c [probe:t4]'])
    for (const abandoned of ['second [probe:t2]', 'branch b [probe:t3]']) expect(JSON.stringify(foreign.entries.map(entry => entry.kind === 'message' ? entry.content : null))).not.toContain(abandoned)
  })

  it('a compacted Pi session hands another provider the summary plus exactly what Pi keeps', () => {
    const sliced = conversationAfterLatestPortableCompaction(decodePiConversation(load('compaction')))
    const claude = targets[0]![1](sliced)
    const text = JSON.stringify(claude.entries.map(entry => entry.kind === 'message' ? entry.content : entry.kind === 'compaction' ? entry.summary : null))
    expect(text).toContain('Reply to a 1050-character prompt.')
    expect(userTexts(claude.entries).filter(t => t.includes('[probe:'))).toEqual(['after compaction [probe:c4]'])
    for (const summarized of ['one [probe:c1]', 'two [probe:c2]', 'three [probe:c3]']) expect(text).not.toContain(summarized)
  })

  it('a recorded Grok session imports into Pi with its request and tool cycle', () => {
    const grok = readFileSync(new URL('../../fixtures/evidence/grok/command.jsonl', import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    const result = projectPiNativeResume(decodeGrokConversation(grok), options)
    const returned = decodePiConversation(result.values)
    expect(userTexts(returned.entries)).toEqual(['Run this exact shell command: touch PERMISSION_PROBE.txt'])
    expect(returned.entries.filter(entry => entry.kind === 'tool-call').map(entry => (entry as { name: string }).name)).toEqual(['run_terminal_command'])
    expect(returned.entries.filter(entry => entry.kind === 'tool-result').map(entry => (entry as { output: unknown }).output)).toEqual(['exit: 0'])
    // Grok's system/bootstrap records are provider policy, not Pi context.
    expect(JSON.stringify(result.values)).not.toContain('"role":"system"')
  })
})

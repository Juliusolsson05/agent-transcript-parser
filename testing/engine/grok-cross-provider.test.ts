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
import { decodeJsonl, encodeJsonlValues } from '../../src/jsonl/index.js'
import type { ConversationDocument } from '../../src/conversation/types.js'
import { decodeGrokConversation } from '../../src/grok/conversation/decode.js'
import { projectGrokNativeResume } from '../../src/grok/project/project.js'

const records = readFileSync(new URL('../../fixtures/evidence/grok/command.jsonl', import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line))
const options = { targetSessionId: '11111111-1111-4111-8111-111111111111', now: '2026-09-08T12:00:00Z', cwd: '/workspace/target', model: 'test-model', version: '2.1.0', cliVersion: '1.0.13', modelProvider: 'test' }
const targets: Array<[string, (conversation: ConversationDocument) => ConversationDocument]> = [
  ['claude', conversation => decodeClaudeConversation(classifyClaudeDocument(decodeJsonl(encodeJsonlValues(projectClaudeNativeResume(conversation, options).values))).records)],
  ['codex', conversation => decodeCodexConversation(classifyCodexDocument(decodeJsonl(encodeJsonlValues(projectCodexNativeResume(conversation, options).values))).records)],
  ['opencode', conversation => decodeOpencodeConversation(projectOpencodeNativeResume(conversation, options).values[0])],
]

describe('Grok uses the neutral hub, not pairwise converters', () => {
  it.each(targets)('keeps both tool cycles through %s without relying on global source-line uniqueness', (name, target) => {
    const source = decodeGrokConversation([
      { type: 'user', content: [{ type: 'text', text: 'Read both files.' }] },
      { type: 'assistant', content: 'Reading both.', tool_calls: [{ id: 'a', name: 'read_file', arguments: '{"path":"a"}' }, { id: 'b', name: 'read_file', arguments: '{"path":"b"}' }] },
      { type: 'tool_result', tool_call_id: 'a', content: 'A' },
      { type: 'tool_result', tool_call_id: 'b', content: 'B' },
    ])
    const projected = projectGrokNativeResume(target(source), options)
    const returned = decodeGrokConversation(projected.values)
    const calls = returned.entries.filter(entry => entry.kind === 'tool-call')
    const results = returned.entries.filter(entry => entry.kind === 'tool-result')
    expect(calls).toHaveLength(2)
    expect(results.map(entry => entry.callId)).toEqual(calls.map(entry => entry.callId))
    expect(results.map(entry => entry.output)).toEqual(['A', 'B'])
    // Claude retains a block array from one source record. Codex stores
    // separate response_item lines; OpenCode stores each completed tool part.
    // Do not force those formats back into an invented parallel record.
    if (name === 'claude') expect(projected.values.some(value => Array.isArray(value.tool_calls) && value.tool_calls.length === 2)).toBe(true)
  })
  it.each(targets)('preserves the recorded user request and tool cycle through %s and back', (_name, target) => {
    const source = decodeGrokConversation(records)
    const before = JSON.stringify(source)
    const foreign = target(source)
    const projected = projectGrokNativeResume(foreign, options)
    const returned = decodeGrokConversation(projected.values)
    const users = returned.entries.filter(entry => entry.kind === 'message' && entry.role === 'user')
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject({ content: [{ kind: 'text', text: 'Run this exact shell command: touch PERMISSION_PROBE.txt' }] })
    expect(returned.entries.filter(entry => entry.kind === 'tool-call').map(entry => entry.name)).toEqual(['run_terminal_command'])
    expect(returned.entries.filter(entry => entry.kind === 'tool-result').map(entry => entry.output)).toEqual(['exit: 0'])
    expect(JSON.stringify(source)).toBe(before)
    expect(JSON.stringify(projected.values)).not.toContain('Native system instructions omitted')
  })

  it.each(targets)('preserves a source-shaped HTTPS image through %s', (_name, target) => {
    // Schema-based boundary regression, not a recorded image capture. No URL
    // is fetched by the parser or this test; native image ingestion is separate.
    const source = decodeGrokConversation([{ type: 'user', content: [{ type: 'image', url: 'https://example.invalid/fixture.png' }] }])
    const foreign = target(source)
    const returned = projectGrokNativeResume(foreign, options)
    expect(JSON.stringify(returned.values)).toContain('https://example.invalid/fixture.png')
    expect(returned.report.changes.some(change => change.code === 'native-resume.content.image.dropped')).toBe(false)
  })
})

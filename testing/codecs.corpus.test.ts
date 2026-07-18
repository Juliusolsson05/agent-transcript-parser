import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { ClaudeCodec } from '../src/codecs/claude.js'
import { CodexCodec } from '../src/codecs/codex.js'
import { translateToClaude, translateToCodex } from '../src/neutral/translate.js'
import { toClaude } from '../src/toClaude.js'
import { toCodex } from '../src/toCodex.js'
import type { ClaudeEntry, CodexRolloutLine } from '../src/types.js'
import { validateRollout } from './codex-validator/src/index.js'

function parseJsonl<T>(file: string): T[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as T)
}

const claudeFixtures = readdirSync('fixtures/claude')
  .filter(name => name.endsWith('.jsonl'))
  .map(name => [name, join('fixtures/claude', name)] as const)
const codexFixtures = readdirSync('fixtures/codex')
  .filter(name => name.endsWith('.jsonl'))
  .map(name => [name, join('fixtures/codex', name)] as const)

// WHY these expectations are hand-authored instead of derived from either
// codec: round-trip fidelity protects raw records, but it cannot prove the
// decoder understood them. This compact table is the independent semantic
// oracle; changing message/tool/compaction classification must now produce an
// intentional, reviewable expectation diff for every affected fixture.
const expectedKinds = {
  claude: {
    'compact-flow.jsonl': [
      'userMessage',
      'assistantMessage',
      'compaction',
      'userMessage',
      'userMessage',
      'assistantMessage',
    ],
    'multi-block-turn.jsonl': ['userMessage', 'assistantMessage'],
    'simple-chat.jsonl': ['userMessage', 'assistantMessage'],
    'tool-cycle.jsonl': [
      'userMessage',
      'assistantMessage',
      'userMessage',
      'assistantMessage',
    ],
  },
  codex: {
    'approval-flow.jsonl': [
      'sessionMeta',
      'userMessage',
      'lifecycleEvent',
      'toolCall',
      'toolResult',
      'assistantMessage',
    ],
    'compact-flow.jsonl': [
      'sessionMeta',
      'userMessage',
      'assistantMessage',
      'compaction',
      'userMessage',
      'assistantMessage',
    ],
    'simple-chat.jsonl': [
      'sessionMeta',
      'userMessage',
      'assistantMessage',
      'userMessage',
    ],
    'tool-cycle.jsonl': [
      'sessionMeta',
      'userMessage',
      'toolCall',
      'toolResult',
      'assistantMessage',
    ],
  },
} as const

const targetSessionId = '019d9999-0000-7000-0000-00000000abcd'

describe('neutral codec corpus', () => {
  for (const [name, file] of claudeFixtures) {
    it(`preserves every Claude record in ${name}`, () => {
      const source = parseJsonl<ClaudeEntry>(file)
      expect(ClaudeCodec.encode(ClaudeCodec.decode(source)).lines).toEqual(source)
    })

    it(`classifies the expected Claude semantics in ${name}`, () => {
      const neutral = ClaudeCodec.decode(parseJsonl<ClaudeEntry>(file))
      expect(neutral.entries.map(entry => entry.kind)).toEqual(
        expectedKinds.claude[name as keyof typeof expectedKinds.claude],
      )
    })

    it(`emits schema-valid Codex when translating ${name}`, () => {
      const neutral = ClaudeCodec.decode(parseJsonl<ClaudeEntry>(file))
      const encoded = CodexCodec.encode(neutral, { targetSessionId }).lines
      const report = validateRollout(encoded)

      expect(report.issues.filter(issue => issue.severity === 'error')).toEqual([])
      expect(report.ok).toBe(true)
    })
  }

  for (const [name, file] of codexFixtures) {
    it(`preserves every Codex record in ${name}`, () => {
      const source = parseJsonl<CodexRolloutLine>(file)
      expect(CodexCodec.encode(CodexCodec.decode(source)).lines).toEqual(source)
    })

    it(`classifies the expected Codex semantics in ${name}`, () => {
      const source = parseJsonl<CodexRolloutLine>(file)
      expect(CodexCodec.decode(source).entries.map(entry => entry.kind)).toEqual(
        expectedKinds.codex[name as keyof typeof expectedKinds.codex],
      )
    })

    it(`conforms to the pinned upstream Codex schema in ${name}`, () => {
      const report = validateRollout(parseJsonl<CodexRolloutLine>(file))
      expect(report.issues.filter(issue => issue.severity === 'error')).toEqual([])
      expect(report.ok).toBe(true)
    })
  }

  it('classifies simple provider conversations into equivalent semantic turns', () => {
    const claude = ClaudeCodec.decode(parseJsonl<ClaudeEntry>('fixtures/claude/simple-chat.jsonl'))
    const codex = CodexCodec.decode(parseJsonl<CodexRolloutLine>('fixtures/codex/simple-chat.jsonl'))

    expect(claude.entries.map(entry => entry.kind)).toEqual([
      'userMessage',
      'assistantMessage',
    ])
    expect(codex.entries.map(entry => entry.kind)).toContain('userMessage')
    expect(codex.entries.map(entry => entry.kind)).toContain('assistantMessage')
  })
})

describe('neutral translation compatibility', () => {
  for (const [name, file] of codexFixtures) {
    it(`matches the public Codex-to-Claude converter for ${name}`, () => {
      const source = parseJsonl<CodexRolloutLine>(file)
      const neutral = CodexCodec.decode(source)

      expect(ClaudeCodec.encode(neutral).lines).toEqual(toClaude(source))
      expect(translateToClaude(neutral, { lossy: true }).lines).toEqual(
        toClaude(source, { lossy: true }),
      )
    })
  }

  for (const [name, file] of claudeFixtures) {
    it(`matches the public Claude-to-Codex converter for ${name}`, () => {
      const source = parseJsonl<ClaudeEntry>(file)
      const neutral = ClaudeCodec.decode(source)
      // WHY the target ID is fixed: both converters mint a fresh Codex
      // session by default. Pinning the only nondeterministic field lets this
      // compare semantic output rather than coincidental UUID timing.
      const options = { targetSessionId }

      expect(CodexCodec.encode(neutral, options).lines).toEqual(toCodex(source, options))
      expect(translateToCodex(neutral, { ...options, lossy: true }).lines).toEqual(
        toCodex(source, { ...options, lossy: true }),
      )
    })
  }
})

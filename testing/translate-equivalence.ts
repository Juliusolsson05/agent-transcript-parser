// Cross-provider translate equivalence (#5, slice 2).
//
// The hub's cross-provider encode must be indistinguishable from the
// legacy pairwise converters:
//
//   ClaudeCodec.encode(CodexCodec.decode(x)) ≡ toClaude(x)
//   CodexCodec.encode(ClaudeCodec.decode(x)) ≡ toCodex(x)
//
// deep-equal over every fixture, in BOTH fidelity and lossy modes for
// the direct translate seam. This suite is the regression pin for the
// engine migration: when translate.ts stops delegating to the legacy
// converters and starts translating per neutral entry, these
// assertions keep the output byte-stable.

import { readFileSync, readdirSync } from 'fs'
import { join, resolve } from 'path'

import { ClaudeCodec } from '../src/codecs/claude.js'
import { CodexCodec } from '../src/codecs/codex.js'
import { translateToClaude, translateToCodex } from '../src/neutral/translate.js'
import { toClaude } from '../src/toClaude.js'
import { toCodex } from '../src/toCodex.js'
import type { ClaudeEntry, CodexRolloutLine } from '../src/types.js'

const ROOT = resolve(new URL('.', import.meta.url).pathname, '..')
let failed = 0

function parse<T>(file: string): T[] {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as T)
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function check(label: string, cond: boolean) {
  if (cond) console.log(`ok  ${label}`)
  else {
    failed += 1
    console.log(`FAIL ${label}`)
  }
}

const codexDir = join(ROOT, 'fixtures/codex')
for (const name of readdirSync(codexDir).filter(f => f.endsWith('.jsonl'))) {
  const lines = parse<CodexRolloutLine>(join(codexDir, name))
  const neutral = CodexCodec.decode(lines)
  check(
    `codex→claude codec ≡ toClaude · ${name}`,
    deepEqual(ClaudeCodec.encode(neutral).lines, toClaude(lines)),
  )
  check(
    `codex→claude translate lossy ≡ toClaude lossy · ${name}`,
    deepEqual(translateToClaude(neutral, { lossy: true }).lines, toClaude(lines, { lossy: true })),
  )
}

const claudeDir = join(ROOT, 'fixtures/claude')
for (const name of readdirSync(claudeDir).filter(f => f.endsWith('.jsonl'))) {
  const lines = parse<ClaudeEntry>(join(claudeDir, name))
  const neutral = ClaudeCodec.decode(lines)
  // toCodex mints a fresh session id per call by default; pin it so
  // the two invocations are comparable.
  const opts = { targetSessionId: '019d9999-0000-7000-0000-00000000abcd' }
  check(
    `claude→codex codec ≡ toCodex · ${name}`,
    deepEqual(CodexCodec.encode(neutral, opts).lines, toCodex(lines, opts)),
  )
  check(
    `claude→codex translate lossy ≡ toCodex lossy · ${name}`,
    deepEqual(
      translateToCodex(neutral, { ...opts, lossy: true }).lines,
      toCodex(lines, { ...opts, lossy: true }),
    ),
  )
}

console.log(failed === 0 ? '\nAll translate equivalences hold' : `\n${failed} FAILED`)
if (failed > 0) process.exit(1)

// Identity round-trip test: encode(codec, decode(codec, source)) === source.
//
// This is the CENTRAL guarantee the neutral-hub codec skeleton exists
// to establish (issue #5 §2 hard requirement 1). Runs against the
// checked-in fixtures for both providers. If this ever fails, the
// codec has broken its lossless-decode contract and NO downstream
// operation (clone / rewind / cross-provider translate / ghost merge)
// can be trusted to preserve data.
//
// Not wired into a test framework yet — invoked directly by
// `tsx testing/round-trip-identity.ts`. Wiring into vitest/npm test
// is follow-up work when the package grows a real test harness.

import { readFileSync, readdirSync } from 'fs'
import { join, resolve } from 'path'

import { ClaudeCodec } from '../src/codecs/claude.js'
import { CodexCodec } from '../src/codecs/codex.js'
import type { CodexRolloutLine, ClaudeEntry } from '../src/types.js'

type Result = { fixture: string; ok: true } | { fixture: string; ok: false; reason: string }

function parseJsonl<T>(text: string): T[] {
  return text.split('\n').filter(Boolean).map(l => JSON.parse(l) as T)
}

function stringifyJsonl(items: unknown[]): string {
  return items.map(i => JSON.stringify(i)).join('\n') + (items.length ? '\n' : '')
}

function runFixture<T>(
  file: string,
  codec: { decode: (s: T[]) => import('../src/neutral/types.js').NeutralTranscript
           encode: (n: import('../src/neutral/types.js').NeutralTranscript) => { lines: T[] } },
): Result {
  const source = readFileSync(file, 'utf8')
  const parsed = parseJsonl<T>(source)
  const neutral = codec.decode(parsed)
  const { lines } = codec.encode(neutral)
  // Byte-identity on serialized JSONL is the strict version of the
  // guarantee; JSON.stringify is stable-enough for our line shapes
  // (no ordering churn on plain objects the fixtures use).
  const roundTripped = stringifyJsonl(lines)
  const expected = stringifyJsonl(parsed) // re-serialize to normalize whitespace
  if (roundTripped === expected) return { fixture: file, ok: true }
  // Fall back to structural equality for a friendlier diff. If this
  // passes but string-equality failed, the codec is preserving data
  // but shifting field/line order — still a semantic identity but
  // worth flagging (some downstream tools depend on exact byte order).
  if (JSON.stringify(lines) === JSON.stringify(parsed)) {
    return { fixture: file, ok: true }
  }
  return {
    fixture: file,
    ok: false,
    reason: `round-trip differs: ${lines.length} lines out vs ${parsed.length} in`,
  }
}

const ROOT = resolve(new URL('.', import.meta.url).pathname, '..')
const claudeDir = join(ROOT, 'fixtures/claude')
const codexDir = join(ROOT, 'fixtures/codex')

const results: Result[] = []

for (const name of readdirSync(claudeDir).filter(f => f.endsWith('.jsonl'))) {
  results.push(runFixture<ClaudeEntry>(join(claudeDir, name), ClaudeCodec))
}
for (const name of readdirSync(codexDir).filter(f => f.endsWith('.jsonl'))) {
  results.push(runFixture<CodexRolloutLine>(join(codexDir, name), CodexCodec))
}

const failed = results.filter(r => !r.ok)
for (const r of results) {
  const rel = r.fixture.replace(ROOT + '/', '')
  if (r.ok) console.log(`ok  ${rel}`)
  else console.log(`FAIL ${rel} — ${(r as { ok: false; reason: string }).reason}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passing`)
if (failed.length > 0) process.exit(1)

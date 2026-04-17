// Convert a real Claude transcript to Codex WITHOUT sidecars, then
// convert that Codex rollout back to Claude and compare the result to
// the original Claude transcript.
//
// This answers the question:
//   "What survives if we stop preserving Claude-only structure and
//    only keep the natively representable Codex form?"
//
// Usage:
//   npx tsx testing/round-trip-claude-lossy.ts <claude-session.jsonl>

import { readFileSync } from 'node:fs'

import { toClaude } from '../src/toClaude.js'
import { toCodex } from '../src/toCodex.js'
import type { ClaudeEntry, CodexRolloutLine } from '../src/types.js'

const SRC = process.argv[2]
if (!SRC) {
  console.error(
    'usage: tsx testing/round-trip-claude-lossy.ts <claude-session.jsonl>',
  )
  process.exit(2)
}

function readJsonl<T>(path: string): T[] {
  const text = readFileSync(path, 'utf8').trim()
  if (!text) return []
  return text.split('\n').map((line, i) => {
    try {
      return JSON.parse(line) as T
    } catch (err) {
      throw new Error(`parse error on line ${i + 1}: ${(err as Error).message}`)
    }
  })
}

function diffSummary(a: unknown, b: unknown): string {
  const sa = JSON.stringify(a)
  const sb = JSON.stringify(b)
  if (sa === sb) return 'equal'
  let i = 0
  while (i < sa.length && i < sb.length && sa[i] === sb[i]) i++
  const before = sa.slice(Math.max(0, i - 60), i)
  const aSlice = sa.slice(i, i + 120)
  const bSlice = sb.slice(i, i + 120)
  return `diverges at char ${i} after "...${before}"\noriginal:  ${aSlice}\nrebuilt:   ${bSlice}`
}

function countBy<T>(items: readonly T[], pick: (item: T) => string): Record<string, number> {
  const out = new Map<string, number>()
  for (const item of items) {
    const key = pick(item)
    out.set(key, (out.get(key) ?? 0) + 1)
  }
  return Object.fromEntries([...out.entries()].sort((a, b) => a[0].localeCompare(b[0])))
}

const original = readJsonl<ClaudeEntry>(SRC)
const codex = toCodex(original, { lossy: true })
const rebuilt = toClaude(codex, { lossy: true })

const exact = JSON.stringify(original) === JSON.stringify(rebuilt)

console.log(`source: ${SRC}`)
console.log(`original Claude entries: ${original.length}`)
console.log(
  `original entry types: ${JSON.stringify(countBy(original, entry => entry.type))}`,
)
console.log(`lossy Codex rollout lines: ${codex.length}`)
console.log(
  `lossy Codex line types: ${JSON.stringify(countBy(codex, line => line.type))}`,
)
console.log(`rebuilt Claude entries: ${rebuilt.length}`)
console.log(
  `rebuilt entry types: ${JSON.stringify(countBy(rebuilt, entry => entry.type))}`,
)
console.log(`exact match: ${exact}`)

if (!exact) {
  console.log('\nfirst diff:')
  console.log(diffSummary(original, rebuilt))
}

// Print a quick structural sample at the front so we can spot what
// disappeared without paging through the full JSON.
console.log('\nfront sample:')
for (let i = 0; i < Math.min(8, original.length, rebuilt.length); i++) {
  const a = original[i]
  const b = rebuilt[i]
  console.log(
    JSON.stringify({
      index: i,
      originalType: a?.type,
      rebuiltType: b?.type,
      originalHasMessage: !!a?.message,
      rebuiltHasMessage: !!b?.message,
      originalSubtype: a?.subtype,
      rebuiltSubtype: b?.subtype,
    }),
  )
}

// Also show which original Claude-only entry types vanish entirely.
const originalTypes = new Set(original.map(entry => entry.type))
const rebuiltTypes = new Set(rebuilt.map(entry => entry.type))
const missingTypes = [...originalTypes].filter(type => !rebuiltTypes.has(type)).sort()
console.log(`\nmissing rebuilt entry types: ${JSON.stringify(missingTypes)}`)

// Surface how many entries lost their original uuid/session linkage.
const matchingUuidCount = rebuilt.filter((entry, i) => entry.uuid === original[i]?.uuid).length
console.log(`uuid matches at same index: ${matchingUuidCount}/${Math.min(original.length, rebuilt.length)}`)


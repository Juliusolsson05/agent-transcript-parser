// Round-trip an existing real Codex rollout file through toClaude
// then toCodex. Write the output to a fresh path with a fresh
// session ID. If the resulting file renders agent messages → the
// translator pipeline is fine and the bug is in how we GENERATE
// rollouts from Claude entries. If it doesn't render → we have a
// shape bug that breaks even known-good Codex content.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { toClaude } from '../src/toClaude.js'
import { toCodex } from '../src/toCodex.js'
import type { CodexRolloutLine } from '../src/types.js'

const SRC = process.argv[2]
if (!SRC) {
  console.error('usage: tsx testing/round-trip-real.ts <real-codex-rollout.jsonl>')
  process.exit(2)
}

const original: CodexRolloutLine[] = readFileSync(SRC, 'utf8')
  .trim().split('\n').map(l => JSON.parse(l))

console.log(`source: ${SRC}`)
console.log(`source lines: ${original.length}`)

const claude = toClaude(original)
// Strip sidecars from intermediate so toCodex actually exercises
// the mapping logic instead of short-circuiting back to verbatim
// source emission. This makes the round-trip a real test of
// "synthesize Codex format from Claude content."
const claudeStripped = claude.map(e => {
  const { _atp, ...rest } = e as Record<string, unknown> & { _atp?: unknown }
  void _atp
  return rest
}) as typeof claude
const codex = toCodex(claudeStripped)

console.log(`claude entries: ${claude.length}`)
console.log(`round-tripped codex lines: ${codex.length}`)

// Reassign session_meta id so we don't collide with the source
const newId = randomUUID()
const firstMeta = codex.find(l => l.type === 'session_meta')
if (firstMeta && (firstMeta.payload as { id?: string }).id) {
  ;(firstMeta.payload as { id: string }).id = newId
}

const now = new Date()
const fname = `rollout-${now.toISOString().slice(0,19).replace(/:/g,'-')}-${newId}.jsonl`
const dir = join(homedir(), '.codex', 'sessions', '2026', '04', '13')
mkdirSync(dir, { recursive: true })
const out = join(dir, fname)
writeFileSync(out, codex.map(l => JSON.stringify(l)).join('\n') + '\n')
console.log(`wrote: ${out}`)
console.log(`session id: ${newId}`)

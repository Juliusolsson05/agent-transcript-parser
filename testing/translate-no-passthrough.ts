// Like translate-any but strips atp_passthrough lines from output,
// so we can test whether those unknown-type lines are disrupting
// Codex's rendering.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import { toCodex } from '../src/toCodex.js'
import type { ClaudeEntry, CodexRolloutLine } from '../src/types.js'

const SRC = process.argv[2]
if (!SRC) {
  console.error('usage: tsx testing/translate-no-passthrough.ts <claude.jsonl>')
  process.exit(2)
}

const entries: ClaudeEntry[] = readFileSync(SRC, 'utf8').trim().split('\n').map(l => JSON.parse(l))
const codex = toCodex(entries)
const cleaned: CodexRolloutLine[] = codex.filter(l => l.type !== 'atp_passthrough')

const id = ((cleaned[0]?.payload as { id?: string } | undefined)?.id)
  ?? basename(SRC, '.jsonl')
const now = new Date()
const fname = `rollout-${now.toISOString().slice(0,19).replace(/:/g,'-')}-${id}.jsonl`
const dir = join(homedir(), '.codex', 'sessions', '2026', '04', '13')
mkdirSync(dir, { recursive: true })
const out = join(dir, fname)
writeFileSync(out, cleaned.map(l => JSON.stringify(l)).join('\n') + '\n')
console.log(`wrote ${out}`)
console.log(`total: ${cleaned.length}  (dropped atp_passthrough: ${codex.length - cleaned.length})`)
console.log(`session id: ${id}`)

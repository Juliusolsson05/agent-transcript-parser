// Trim trailing user-only turns (Claude's compaction markers,
// local-command bookkeeping, etc.) from the END of a translation so
// the resumed conversation in Codex shows assistant content at the
// bottom of the viewport instead of a wall of system-y user messages.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import { toCodex } from '../src/toCodex.js'
import type { ClaudeEntry } from '../src/types.js'

const SRC = process.argv[2]
if (!SRC) {
  console.error('usage: tsx testing/translate-trim-tail.ts <claude.jsonl>')
  process.exit(2)
}

const entries: ClaudeEntry[] = readFileSync(SRC, 'utf8').trim().split('\n').map(l => JSON.parse(l))

// Walk back from the end, drop entries until we find an assistant
// entry. This keeps the conversation ending on agent text — which is
// what Codex's resume viewport will display.
let cutoff = entries.length
for (let i = entries.length - 1; i >= 0; i--) {
  if (entries[i]!.type === 'assistant') {
    cutoff = i + 1
    break
  }
}
const trimmed = entries.slice(0, cutoff)
console.log(`trimmed ${entries.length - trimmed.length} trailing entries (kept ${trimmed.length})`)

const codex = toCodex(trimmed)
const id = basename(SRC, '.jsonl')
const now = new Date()
const fname = `rollout-${now.toISOString().slice(0,19).replace(/:/g,'-')}-${id}.jsonl`
const dir = join(homedir(), '.codex', 'sessions', '2026', '04', '13')
mkdirSync(dir, { recursive: true })
const out = join(dir, fname)
writeFileSync(out, codex.map(l => JSON.stringify(l)).join('\n') + '\n')
console.log(`wrote ${out}  (${codex.length} lines)`)

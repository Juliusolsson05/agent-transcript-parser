// Translate ANY Claude session file to Codex format and place it in
// ~/.codex/sessions/YYYY/MM/DD/. Useful for testing against
// different sessions without editing a hardcoded path.
//
// Usage:
//   npx tsx testing/translate-any.ts <path-to-claude-session.jsonl> [--write]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import { toCodex } from '../src/toCodex.js'
import type { ClaudeEntry } from '../src/types.js'

const SRC = process.argv[2]
const dryRun = !process.argv.includes('--write')
if (!SRC) {
  console.error('usage: tsx testing/translate-any.ts <path-to-claude.jsonl> [--write]')
  process.exit(2)
}

console.log(`Reading: ${SRC}`)
const claudeText = readFileSync(SRC, 'utf8').trim()
const entries: ClaudeEntry[] = claudeText.split('\n').map((line, i) => {
  try {
    return JSON.parse(line) as ClaudeEntry
  } catch (err) {
    throw new Error(`parse error on line ${i + 1}: ${(err as Error).message}`)
  }
})
console.log(`Loaded ${entries.length} Claude entries`)

console.log('Converting → Codex …')
const codexLines = toCodex(entries)
console.log(`Produced ${codexLines.length} Codex rollout lines`)

const sessionId = ((codexLines[0]?.payload as { id?: string } | undefined)?.id)
  ?? basename(SRC, '.jsonl')

const now = new Date()
const yyyy = String(now.getFullYear())
const mm = String(now.getMonth() + 1).padStart(2, '0')
const dd = String(now.getDate()).padStart(2, '0')
const HH = String(now.getHours()).padStart(2, '0')
const MM = String(now.getMinutes()).padStart(2, '0')
const SS = String(now.getSeconds()).padStart(2, '0')
const tsForName = `${yyyy}-${mm}-${dd}T${HH}-${MM}-${SS}`

const outDir = join(homedir(), '.codex', 'sessions', yyyy, mm, dd)
const outFile = join(outDir, `rollout-${tsForName}-${sessionId}.jsonl`)
console.log(`\nTarget: ${outFile}`)

if (dryRun) {
  console.log('\n(dry run — re-run with --write to actually create the file)')
  process.exit(0)
}

mkdirSync(outDir, { recursive: true })
const text = codexLines.map(l => JSON.stringify(l)).join('\n') + '\n'
writeFileSync(outFile, text, 'utf8')
console.log(`\nWrote ${text.length} bytes`)
console.log(`Session ID for codex resume: ${sessionId}`)

// Translate a Codex rollout JSONL into a Claude session JSONL and
// drop it where Claude Code expects to find it, so it shows up in
// `claude --resume` (or whatever picker a consumer wires up).
//
// Claude stores sessions at:
//   ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
// where <encoded-cwd> is the absolute cwd with '/' replaced by '-'.
//
// Usage:
//   npx tsx testing/translate-codex-to-claude.ts <path-to-codex-rollout.jsonl> [--write]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import { toClaude } from '../src/toClaude.js'
import type { CodexRolloutLine } from '../src/types.js'

const SRC = process.argv[2]
const dryRun = !process.argv.includes('--write')
if (!SRC) {
  console.error('usage: tsx testing/translate-codex-to-claude.ts <codex-rollout.jsonl> [--write]')
  process.exit(2)
}

console.log(`Reading: ${SRC}`)
const text = readFileSync(SRC, 'utf8').trim()
const codexLines: CodexRolloutLine[] = text.split('\n').map((line, i) => {
  try {
    return JSON.parse(line) as CodexRolloutLine
  } catch (err) {
    throw new Error(`parse error on line ${i + 1}: ${(err as Error).message}`)
  }
})
console.log(`Loaded ${codexLines.length} Codex rollout lines`)

// Pull metadata out of session_meta before converting, so we know
// where to drop the output file (Claude partitions sessions by cwd).
const meta = codexLines.find(l => l.type === 'session_meta')
const metaPayload = (meta?.payload ?? {}) as { id?: string; cwd?: string }
const cwd = metaPayload.cwd
if (!cwd) {
  console.error('session_meta has no cwd; cannot pick a Claude projects directory')
  process.exit(1)
}

console.log('Converting → Claude …')
const claudeEntries = toClaude(codexLines)
console.log(`Produced ${claudeEntries.length} Claude entries`)

const outTypes = new Map<string, number>()
for (const e of claudeEntries) outTypes.set(e.type, (outTypes.get(e.type) ?? 0) + 1)
console.log('Output types:', Object.fromEntries(outTypes))

// Claude's on-disk project id is the absolute cwd with '/' → '-'.
// Leading slash also becomes a leading '-', which is why the directory
// names in ~/.claude/projects look like "-Users-foo-bar-repo".
const projectDir = cwd.replace(/\//g, '-')

// Pick the output session id. Claude uses one file per session named
// by uuid; reusing the Codex session id is fine on the Claude side
// because Claude doesn't have the SQLite-cache hazard that poisoned
// the Codex direction. Fall back to the source filename stem if the
// Codex file somehow had no session id.
const sessionId = metaPayload.id ?? basename(SRC, '.jsonl')

const outDir = join(homedir(), '.claude', 'projects', projectDir)
const outFile = join(outDir, `${sessionId}.jsonl`)
console.log(`\nTarget: ${outFile}`)

if (dryRun) {
  console.log('\n(dry run — re-run with --write to actually create the file)')
  process.exit(0)
}

mkdirSync(outDir, { recursive: true })
const outText = claudeEntries.map(e => JSON.stringify(e)).join('\n') + '\n'
writeFileSync(outFile, outText, 'utf8')
console.log(`\nWrote ${outText.length} bytes`)
console.log(`Session ID for claude --resume: ${sessionId}`)

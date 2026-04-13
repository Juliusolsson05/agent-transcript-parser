// Standalone round-trip runner (tsx). Loads every fixture, converts
// both directions, asserts deepEqual. Mirrors the verify.ts pattern
// from claude-code-headless / codex-headless — no jest dependency.

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { toClaude } from '../src/toClaude.js'
import { toCodex } from '../src/toCodex.js'
import type { ClaudeEntry, CodexRolloutLine } from '../src/types.js'

const here = dirname(fileURLToPath(import.meta.url))
const CODEX_DIR = join(here, '..', 'fixtures', 'codex')
const CLAUDE_DIR = join(here, '..', 'fixtures', 'claude')

let failed = 0

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`✓ ${label}`)
  else {
    console.error(`✗ ${label}${detail ? ` — ${detail}` : ''}`)
    failed++
  }
}

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as T)
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value)
}

// ---------------------------------------------------------------------------
// Codex → Claude smoke checks
// ---------------------------------------------------------------------------

for (const name of readdirSync(CODEX_DIR).filter(f => f.endsWith('.jsonl'))) {
  const codex = readJsonl<CodexRolloutLine>(join(CODEX_DIR, name))
  let claude: ClaudeEntry[] = []
  let threw: unknown = null
  try {
    claude = toClaude(codex)
  } catch (err) {
    threw = err
  }
  check(`codex/${name} converts without throwing`, threw === null, String(threw))
  check(`codex/${name} emits at least one entry`, claude.length > 0)
  check(
    `codex/${name} every entry has uuid + sessionId`,
    claude.every(e => typeof e.uuid === 'string' && typeof e.sessionId === 'string'),
  )
}

// ---------------------------------------------------------------------------
// Claude → Codex smoke checks
// ---------------------------------------------------------------------------

for (const name of readdirSync(CLAUDE_DIR).filter(f => f.endsWith('.jsonl'))) {
  const claude = readJsonl<ClaudeEntry>(join(CLAUDE_DIR, name))
  let codex: CodexRolloutLine[] = []
  let threw: unknown = null
  try {
    codex = toCodex(claude)
  } catch (err) {
    threw = err
  }
  check(`claude/${name} converts without throwing`, threw === null, String(threw))
  check(`claude/${name} emits at least one line`, codex.length > 0)
  check(
    `claude/${name} first line is session_meta`,
    codex[0]?.type === 'session_meta',
  )
}

// ---------------------------------------------------------------------------
// Round-trip: Codex → Claude → Codex === Codex
// ---------------------------------------------------------------------------

for (const name of readdirSync(CODEX_DIR).filter(f => f.endsWith('.jsonl'))) {
  const original = readJsonl<CodexRolloutLine>(join(CODEX_DIR, name))
  const claude = toClaude(original)
  const roundTrip = toCodex(claude)
  const ok = stableStringify(roundTrip) === stableStringify(original)
  check(
    `codex/${name} round-trip (Codex→Claude→Codex) bytes match`,
    ok,
    ok ? undefined : `lengths: ${original.length} → ${claude.length} → ${roundTrip.length}`,
  )
}

// ---------------------------------------------------------------------------
// Round-trip: Claude → Codex → Claude === Claude
// ---------------------------------------------------------------------------

for (const name of readdirSync(CLAUDE_DIR).filter(f => f.endsWith('.jsonl'))) {
  const original = readJsonl<ClaudeEntry>(join(CLAUDE_DIR, name))
  const codex = toCodex(original)
  const roundTrip = toClaude(codex)
  const ok = stableStringify(roundTrip) === stableStringify(original)
  check(
    `claude/${name} round-trip (Claude→Codex→Claude) bytes match`,
    ok,
    ok ? undefined : `lengths: ${original.length} → ${codex.length} → ${roundTrip.length}`,
  )
}

// ---------------------------------------------------------------------------
// Lossy mode: no _atp in output
// ---------------------------------------------------------------------------

for (const name of readdirSync(CODEX_DIR).filter(f => f.endsWith('.jsonl'))) {
  const codex = readJsonl<CodexRolloutLine>(join(CODEX_DIR, name))
  const claudeLossy = toClaude(codex, { lossy: true })
  const hasAtp = JSON.stringify(claudeLossy).includes('"_atp"')
  check(`codex/${name} lossy mode strips _atp`, !hasAtp)
}

for (const name of readdirSync(CLAUDE_DIR).filter(f => f.endsWith('.jsonl'))) {
  const claude = readJsonl<ClaudeEntry>(join(CLAUDE_DIR, name))
  const codexLossy = toCodex(claude, { lossy: true })
  const hasAtp = JSON.stringify(codexLossy).includes('"_atp"')
  check(`claude/${name} lossy mode strips _atp`, !hasAtp)
}

// ---------------------------------------------------------------------------
// Exit
// ---------------------------------------------------------------------------

if (failed > 0) {
  console.error(`\n${failed} check${failed === 1 ? '' : 's'} failed`)
  process.exit(1)
}
console.log('\nAll checks passed')

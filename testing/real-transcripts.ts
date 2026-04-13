// Round-trip the converter against REAL transcripts pulled from
// ~/.codex/sessions/ and ~/.claude/projects/. Synthetic fixtures
// only cover the happy path; real transcripts surface format
// variations we haven't seen — file-history snapshots, sidechains,
// dropped event_msg lifecycle events, image content blocks, weirdly
// shaped tool outputs, etc.
//
// Does NOT commit any transcript content. Reads from the local
// filesystem at runtime.
//
// Usage:
//   npx tsx testing/real-transcripts.ts            # default sample
//   ATP_SAMPLE=N npx tsx testing/real-transcripts.ts   # cap per-format
//   ATP_VERBOSE=1 npx tsx testing/real-transcripts.ts  # print first diff per failure

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { toClaude } from '../src/toClaude.js'
import { toCodex } from '../src/toCodex.js'
import type { ClaudeEntry, CodexRolloutLine } from '../src/types.js'

const CODEX_ROOT = join(homedir(), '.codex', 'sessions')
const CLAUDE_ROOT = join(homedir(), '.claude', 'projects')

const SAMPLE_SIZE = Number(process.env.ATP_SAMPLE ?? 10)
const VERBOSE = process.env.ATP_VERBOSE === '1'

let pass = 0
let fail = 0
const failures: Array<{ path: string; reason: string }> = []

function record(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    pass++
    if (VERBOSE) console.log(`✓ ${label}`)
  } else {
    fail++
    failures.push({ path: label, reason: detail ?? 'unknown' })
    console.error(`✗ ${label}${detail ? ` — ${detail.slice(0, 200)}` : ''}`)
  }
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

function walkJsonl(root: string): string[] {
  const out: string[] = []
  function visit(dir: string): void {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      const full = join(dir, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) visit(full)
      else if (name.endsWith('.jsonl')) out.push(full)
    }
  }
  visit(root)
  return out
}

function pickRandom<T>(items: T[], n: number): T[] {
  if (items.length <= n) return [...items]
  const out: T[] = []
  const used = new Set<number>()
  while (out.length < n) {
    const idx = Math.floor(Math.random() * items.length)
    if (used.has(idx)) continue
    used.add(idx)
    out.push(items[idx]!)
  }
  return out
}

function diffSummary(a: unknown, b: unknown): string {
  const sa = JSON.stringify(a)
  const sb = JSON.stringify(b)
  if (sa === sb) return 'equal'
  // Find first diverging character — useful for spotting where things drift.
  let i = 0
  while (i < sa.length && i < sb.length && sa[i] === sb[i]) i++
  const before = sa.slice(Math.max(0, i - 60), i)
  const aSlice = sa.slice(i, i + 80)
  const bSlice = sb.slice(i, i + 80)
  return `diverges at char ${i} after "...${before}"\n   original:  ${aSlice}\n   round-trip: ${bSlice}`
}

// ---------------------------------------------------------------------------
// Codex → Claude → Codex
// ---------------------------------------------------------------------------

console.log(`\n--- Codex → Claude → Codex (sampling up to ${SAMPLE_SIZE}) ---`)
const codexFiles = walkJsonl(CODEX_ROOT)
console.log(`found ${codexFiles.length} Codex transcripts under ${CODEX_ROOT}`)
for (const path of pickRandom(codexFiles, SAMPLE_SIZE)) {
  let original: CodexRolloutLine[]
  try {
    original = readJsonl<CodexRolloutLine>(path)
  } catch (err) {
    record(path, false, `parse fail: ${(err as Error).message}`)
    continue
  }
  if (original.length === 0) {
    record(path, false, 'empty file')
    continue
  }
  let claude: ClaudeEntry[]
  let roundTrip: CodexRolloutLine[]
  try {
    claude = toClaude(original)
    roundTrip = toCodex(claude)
  } catch (err) {
    record(path, false, `convert threw: ${(err as Error).message}`)
    continue
  }
  const ok = JSON.stringify(roundTrip) === JSON.stringify(original)
  record(path, ok, ok ? undefined : diffSummary(original, roundTrip))
}

// ---------------------------------------------------------------------------
// Claude → Codex → Claude
// ---------------------------------------------------------------------------

console.log(`\n--- Claude → Codex → Claude (sampling up to ${SAMPLE_SIZE}) ---`)
const claudeFiles = walkJsonl(CLAUDE_ROOT)
console.log(`found ${claudeFiles.length} Claude transcripts under ${CLAUDE_ROOT}`)
for (const path of pickRandom(claudeFiles, SAMPLE_SIZE)) {
  let original: ClaudeEntry[]
  try {
    original = readJsonl<ClaudeEntry>(path)
  } catch (err) {
    record(path, false, `parse fail: ${(err as Error).message}`)
    continue
  }
  if (original.length === 0) {
    record(path, false, 'empty file')
    continue
  }
  let codex: CodexRolloutLine[]
  let roundTrip: ClaudeEntry[]
  try {
    codex = toCodex(original)
    roundTrip = toClaude(codex)
  } catch (err) {
    record(path, false, `convert threw: ${(err as Error).message}`)
    continue
  }
  const ok = JSON.stringify(roundTrip) === JSON.stringify(original)
  record(path, ok, ok ? undefined : diffSummary(original, roundTrip))
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
if (fail > 0) {
  console.log(`\nFailure breakdown:`)
  const byReason = new Map<string, number>()
  for (const f of failures) {
    const tag = f.reason.split(':')[0]?.split('"')[0]?.trim() ?? f.reason
    byReason.set(tag, (byReason.get(tag) ?? 0) + 1)
  }
  for (const [reason, count] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count}× ${reason}`)
  }
  process.exit(1)
}

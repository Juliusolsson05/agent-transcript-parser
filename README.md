# agent-transcript-parser

Convert agent transcripts between Claude and Codex format. Bidirectional, lossless on round-trip.

```
codex JSONL ──toClaude──▶ claude JSONL
            ◀──toCodex───
```

## What it does

Take a JSONL file produced by one agent CLI, write a JSONL file the other agent CLI can read.

The motivating use case: a "switch provider" command. You're mid-conversation with Codex, you want to continue in Claude. Translate the Codex rollout to Claude format, drop it where Claude expects (`~/.claude/projects/.../<sessionId>.jsonl`), then `claude --resume <sessionId>` picks it up. Same in reverse.

## Round-trip is lossless

```ts
toClaude(toCodex(claudeEntries))  // === claudeEntries
toCodex(toClaude(codexLines))     // === codexLines
```

Anything that doesn't have a native equivalent on the other side gets stashed under an `_atp` field on the converted record. The other agent's parser ignores unknown fields, so the file still loads natively. On the reverse trip we read `_atp.source` and emit it byte-identical.

This means: convert your transcripts to the other format, switch agents, switch back. You get the original bytes.

Pass `{ lossy: true }` to skip the sidecar (smaller files, no round-trip guarantee).

## Install

```bash
npm install agent-transcript-parser
```

Node 18+, ESM-only.

## API

```ts
import {
  toClaude,
  toCodex,
  detectFormat,
  cloneClaudeTranscript,
  cloneCodexRollout,
  rewindClaudeTranscript,
  rewindCodexRollout,
} from 'agent-transcript-parser'

toClaude(codexLines, opts?)        // CodexRolloutLine[] → ClaudeEntry[]
toCodex(claudeEntries, opts?)      // ClaudeEntry[] → CodexRolloutLine[]
detectFormat(input)                // 'claude' | 'codex' | 'unknown'
```

Current shared options:

```ts
type ConvertOptions = {
  lossy?: boolean
  targetSessionId?: string  // used by toCodex when synthesizing session_meta
  sanitizeForResume?: boolean  // toCodex: strip one-shot history mutations
}
```

Plus typed exports for every Claude / Codex shape variant and the sidecar utilities (`ATP_KEY`, `attachSidecar`, `readSidecar`, `stripSidecar`).

## Clone a transcript

Duplicate a session under a fresh id so the resume picker sees it as an independent conversation. Per-entry uuids are preserved by default (Claude's resume flow doesn't cross-reference them across files); pass `regenerateEntryUuids` if you want zero overlap.

```ts
const { entries, newSessionId } = cloneClaudeTranscript(source, {
  // newSessionId?: string         — defaults to a fresh UUID
  // titleSuffix?: string | null   — appended to customTitle entries; default ' (copy)'
  // regenerateEntryUuids?: boolean
})

const { lines, newSessionId } = cloneCodexRollout(source, { /* ... */ })
```

## Rewind a transcript

Rewind to "just before" a chosen user prompt. Everything from the anchored prompt onward is dropped, the result is written under a new session id, and orphaned tool-use pairs (or stranded `compact_boundary` markers) are cleaned up so the truncated file still loads natively.

```ts
const { entries, newSessionId } = rewindClaudeTranscript(source, {
  anchor: { uuid: '…' },  // user-role entry to rewind to
})

const { lines, newSessionId } = rewindCodexRollout(source, {
  anchor: { /* … */ },
})
```

Throws `RewindClaudeAnchorNotFoundError` / `RewindCodexAnchorNotFoundError` when the anchor isn't present in the source, and `RewindCodexMissingSessionMetaError` if the Codex rollout lacks a `session_meta` line.

## Ghost records

atp supports a fourth sidecar origin — `ghost` — for provisional transcript entries that will be reconciled against authoritative ones. Useful when multiple producers share a transcript: live UIs bridging a batched-writer gap, speculative or optimistic writes, offline editors, streaming ingestion pipelines, and multi-producer sessions where one tool writes authoritative records and another writes provisional ones.

```ts
import {
  createGhost,
  updateGhost,
  supersedeGhost,
  reduceGhostLog,
  mergeWithUpstream,
} from 'agent-transcript-parser'
```

Both converters skip ghost records on export, so ghosts never leak into a durable cross-provider rollout. See [`docs/ghost.md`](./docs/ghost.md) for the design rationale, lifecycle, reconciliation semantics, and an end-to-end example.

## Quick example

```ts
import { readFileSync, writeFileSync } from 'node:fs'
import { toClaude } from 'agent-transcript-parser'

const codexLines = readFileSync('rollout.jsonl', 'utf8')
  .trim().split('\n').map(s => JSON.parse(s))

const claudeEntries = toClaude(codexLines)

writeFileSync(
  'session.jsonl',
  claudeEntries.map(e => JSON.stringify(e)).join('\n'),
)
```

## Status

- Library API is complete and stable.
- Synthetic round-trip fixtures pass (30/30 in `testing/verify.ts`).
- Real translator coverage now includes native/intentional mappings for:
  - Codex shell calls <-> Claude `Bash`
  - Codex `tool_search_*` items -> Claude summaries plus `structured_output`
  - Claude `queued_command` -> native Codex user turns
  - Claude thinking -> Codex `reasoning.summary[{ type: 'summary_text' }]`
  - Claude custom tool results -> native Codex `custom_tool_call_output.output` text bodies
  - lossy Claude `tool_result` arrays -> flattened Codex tool output text instead of silent drops
  - lossy Claude image/document user content -> textual Codex fallback markers
  - several Claude attachment families -> Codex assistant commentary fallbacks, including diagnostics, mode/context reminders, plan-file references, invoked skills, and reminder/instruction attachments
  - Codex structured tool outputs -> Claude rich `tool_result.content`
- Real-transcript testing started; not yet fully green — see `docs/implementation-plan.md` for known gaps.
- Not yet consumed by a downstream tool — package is built and tested in isolation.

## Dev

```bash
npm install
npm run build       # tsc → dist/
npm run verify      # synthetic round-trip harness
npx tsx testing/real-transcripts.ts   # round-trip against ~/.codex/sessions and ~/.claude/projects
```

## Layout

```
src/
  toClaude.ts / toCodex.ts        translators
  cloneClaude.ts / cloneCodex.ts  session duplication
  rewindClaude.ts / rewindCodex.ts truncate-before-anchor
  detectFormat.ts                 input-shape detection
  sidecar.ts                      _atp envelope (lossless round-trip)
  ghost.ts                        provisional/ghost record helpers
  types.ts                        Claude + Codex JSONL shape types
docs/
  ghost.md                        ghost record design + reconciliation
  implementation-plan.md          known gaps and roadmap
testing/
  verify.ts                       synthetic fixture round-trip
fixtures/                         hand-crafted JSONL samples
```

## License

MIT.

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

## API

```ts
import { toClaude, toCodex, detectFormat } from 'agent-transcript-parser'

toClaude(codexLines, opts?)        // CodexRolloutLine[] → ClaudeEntry[]
toCodex(claudeEntries, opts?)      // ClaudeEntry[] → CodexRolloutLine[]
detectFormat(input)                // 'claude' | 'codex' | 'unknown'

type ConvertOptions = { lossy?: boolean }
```

Current shared options:

```ts
type ConvertOptions = {
  lossy?: boolean
  targetSessionId?: string // used by toCodex when synthesizing session_meta
}
```

Plus typed exports for every Claude / Codex shape variant and the sidecar utilities (`ATP_KEY`, `attachSidecar`, `readSidecar`, `stripSidecar`).

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

## License

MIT.

# agent-transcript-parser — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill in the skeleton created in commit `e46cbe4` with a working bidirectional translator between Codex rollout transcripts and Claude JSONL transcripts, with a lossless round-trip guarantee backed by an `_atp` sidecar.

**Architecture:** Pure functions over arrays. No IO, no runtime deps, no classes. Two primary entry points (`toClaude`, `toCodex`) plus a format detector, all backed by a shared `types.ts` and `sidecar.ts`. Each entry point dispatches on the input record's discriminator, emits one or more target-format records, and attaches an `_atp` sidecar carrying the original record. On the reverse direction, a sidecar short-circuit restores the original byte-for-byte. Fixture-driven round-trip tests via a tsx harness (no jest).

**Tech Stack:** TypeScript 5.5, NodeNext modules, `tsx` for the verify runner. Zero runtime dependencies.

**Commit strategy:** 4 commits, each independently verifiable:
1. **foundation** — `types.ts`, `sidecar.ts`, `util.ts`
2. **toClaude** — Codex → Claude + fixtures + harness wiring
3. **toCodex** — Claude → Codex + fixtures + round-trip passes both ways
4. **public surface** — `detectFormat`, `index.ts` exports, lossy option, README polish

---

## File Structure (locked in commit `e46cbe4`, now gets filled)

```
src/
├── index.ts           — public exports only
├── types.ts           — all shape + sidecar types
├── toClaude.ts        — Codex → Claude (+ internal mappers)
├── toCodex.ts         — Claude → Codex (+ internal mappers)
├── sidecar.ts         — attach/read/strip _atp helpers
└── util.ts            — stableUuid, parseToolInput, normalizeOutput
testing/
└── verify.ts          — round-trip runner
fixtures/
├── codex/             — real sanitized Codex rollouts (one per scenario)
└── claude/            — real sanitized Claude transcripts (one per scenario)
```

---

## Type shapes (source of truth)

All types live in `src/types.ts`. These are LOCAL mirrors — no import from `claude-code-headless` or `codex-headless`. If either format drifts, update here.

### Sidecar

```ts
export const ATP_KEY = '_atp' as const

export type AtpSidecar =
  | { origin: 'claude'; source: ClaudeEntry }
  | { origin: 'codex'; source: CodexRolloutLine }

export type WithAtp<T> = T & { _atp?: AtpSidecar }
```

### Claude

```ts
export type ClaudeRole = 'user' | 'assistant'

export type ClaudeTextBlock = { type: 'text'; text: string }

export type ClaudeToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
  caller?: { type?: string } & Record<string, unknown>
}

export type ClaudeToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  content: string | Array<{ type: string; text?: string; [k: string]: unknown }>
  is_error?: boolean
  /** Round-trip metadata stashed by toClaude when the source was a
   *  Codex custom_tool_call_output (exit_code, custom_tool marker,
   *  etc.). Claude's own transcripts never set this. */
  codex?: Record<string, unknown>
}

export type ClaudeThinkingBlock = {
  type: 'thinking'
  thinking: string
  signature?: string
}

export type ClaudeContentBlock =
  | ClaudeTextBlock
  | ClaudeToolUseBlock
  | ClaudeToolResultBlock
  | ClaudeThinkingBlock
  | { type: string; [k: string]: unknown }   // unknown/forward-compat

export type ClaudeMessage = {
  role: ClaudeRole
  content: string | ClaudeContentBlock[]
  model?: string
  id?: string
  usage?: Record<string, unknown>
  stop_reason?: string | null
  stop_sequence?: string | null
}

export type ClaudeEntry = WithAtp<{
  type: 'user' | 'assistant' | 'system'
  uuid: string
  parentUuid: string | null
  sessionId: string
  timestamp: string           // ISO-8601
  message?: ClaudeMessage     // optional for system + snapshot entries
  cwd?: string
  gitBranch?: string
  requestId?: string
  isSidechain?: boolean
  isMeta?: boolean
  permissionMode?: string
  version?: string
  userType?: string
  entrypoint?: string
  promptId?: string
  slug?: string
  sourceToolAssistantUUID?: string
  sourceToolUseID?: string
  toolUseResult?: Record<string, unknown>
  isCompactSummary?: boolean
  /** System/compact-boundary fields — present when type === 'system' */
  subtype?: string
  content?: string            // for compact_boundary
  compactMetadata?: Record<string, unknown>
  /** File-history-snapshot fields — present when type === 'file-history-snapshot' */
  messageId?: string
  snapshot?: Record<string, unknown>
  isSnapshotUpdate?: boolean
}>
```

### Codex

```ts
export type CodexContentItem =
  | { type: 'input_text'; text: string }
  | { type: 'output_text'; text: string; annotations?: unknown[] }
  | { type: 'refusal'; refusal: string }

export type CodexMessagePayload = {
  type: 'message'
  role: string                // 'user' | 'assistant' | 'developer' | 'system'
  content: CodexContentItem[]
  id?: string
  end_turn?: boolean
  phase?: 'commentary' | 'final_answer'
}

export type CodexFunctionCallPayload = {
  type: 'function_call'
  name: string
  namespace?: string
  arguments: string           // JSON-encoded string
  call_id: string
}

export type CodexFunctionCallOutputPayload = {
  type: 'function_call_output'
  call_id: string
  output: string | Array<{
    type?: string
    text?: string
    metadata?: { exit_code?: number; duration_seconds?: number; [k: string]: unknown }
    [k: string]: unknown
  }>
}

export type CodexCustomToolCallPayload = {
  type: 'custom_tool_call'
  call_id: string
  name: string
  input: string
  status?: string
}

export type CodexCustomToolCallOutputPayload = {
  type: 'custom_tool_call_output'
  call_id: string
  name?: string
  output: string              // often wraps JSON: {output, metadata:{exit_code}}
}

export type CodexReasoningPayload = {
  type: 'reasoning'
  id?: string
  summary?: Array<{ type: string; text?: string }>
  content?: unknown
  encrypted_content?: string
}

export type CodexLocalShellCallPayload = {
  type: 'local_shell_call'
  call_id?: string
  status?: string
  action: {
    type: string
    cmd?: string[]
    workdir?: string
    timeout_seconds?: number
    [k: string]: unknown
  }
}

export type CodexWebSearchCallPayload = {
  type: 'web_search_call'
  status?: string
  action?: { type: string; query?: string; [k: string]: unknown }
}

export type CodexResponseItemPayload =
  | CodexMessagePayload
  | CodexFunctionCallPayload
  | CodexFunctionCallOutputPayload
  | CodexCustomToolCallPayload
  | CodexCustomToolCallOutputPayload
  | CodexReasoningPayload
  | CodexLocalShellCallPayload
  | CodexWebSearchCallPayload
  | { type: string; [k: string]: unknown }  // forward-compat

export type CodexEventMsgPayload =
  | { type: 'exec_approval_request'; call_id: string; command: string[]; workdir?: string }
  | { type: 'exec_command_end'; call_id: string; exit_code?: number }
  | { type: 'mcp_tool_call_begin'; call_id: string; server_name?: string; tool_name?: string }
  | { type: 'token_count'; input_tokens?: number; output_tokens?: number; cached_input_tokens?: number; [k: string]: unknown }
  | { type: 'task_started' | 'task_complete'; turn_id?: string; [k: string]: unknown }
  | { type: 'user_message'; message?: string; [k: string]: unknown }
  | { type: 'agent_message'; message?: string; phase?: string }
  | { type: 'agent_message_delta'; delta?: string }
  | { type: 'error'; message: string; code?: string }
  | { type: string; [k: string]: unknown }

export type CodexSessionMetaPayload = {
  id: string
  timestamp: string
  cwd: string
  originator?: string
  cli_version?: string
  source?: string
  model_provider?: string
  base_instructions?: { text?: string }
  git?: {
    commit_hash?: string
    branch?: string
    repository_url?: string
    dirty?: boolean
  }
  agent_nickname?: string
  agent_role?: string
  agent_path?: string
  forked_from_id?: string
  memory_mode?: string
  [k: string]: unknown
}

export type CodexTurnContextPayload = {
  turn_id: string
  cwd?: string
  current_date?: string
  timezone?: string
  approval_policy?: string
  sandbox_policy?: Record<string, unknown>
  model?: string
  personality?: string
  collaboration_mode?: Record<string, unknown>
  [k: string]: unknown
}

export type CodexRolloutLine = WithAtp<
  | { timestamp: string; type: 'session_meta'; payload: CodexSessionMetaPayload }
  | { timestamp: string; type: 'turn_context'; payload: CodexTurnContextPayload }
  | { timestamp: string; type: 'response_item'; payload: CodexResponseItemPayload }
  | { timestamp: string; type: 'event_msg'; payload: CodexEventMsgPayload }
  | { timestamp: string; type: 'compacted'; payload: Record<string, unknown> }
  | { timestamp: string; type: string; payload: Record<string, unknown> }
>
```

---

## Sidecar primitives (`src/sidecar.ts`)

```ts
import { ATP_KEY, type AtpSidecar, type ClaudeEntry, type CodexRolloutLine, type WithAtp } from './types.js'

export { ATP_KEY } from './types.js'
export type { AtpSidecar } from './types.js'

export function attachSidecar<T extends object>(
  record: T,
  origin: AtpSidecar['origin'],
  source: ClaudeEntry | CodexRolloutLine,
): WithAtp<T> {
  return { ...record, [ATP_KEY]: { origin, source } } as WithAtp<T>
}

export function readSidecar<T extends WithAtp<object>>(record: T): AtpSidecar | null {
  const raw = (record as Record<string, unknown>)[ATP_KEY]
  if (!raw || typeof raw !== 'object') return null
  const s = raw as AtpSidecar
  if (s.origin !== 'claude' && s.origin !== 'codex') return null
  if (!s.source || typeof s.source !== 'object') return null
  return s
}

export function stripSidecar<T extends WithAtp<object>>(record: T): T {
  if (!(ATP_KEY in record)) return record
  const clone: Record<string, unknown> = { ...record }
  delete clone[ATP_KEY]
  return clone as T
}
```

---

## Utility helpers (`src/util.ts`)

```ts
import { createHash } from 'node:crypto'

/**
 * Deterministic uuid from a stable input. Used when a Codex record
 * has no Claude-compatible uuid — we derive one from
 * (sessionId, index, record fingerprint) so repeat conversions of
 * the same transcript produce identical uuids.
 */
export function stableUuid(inputs: Array<string | number>): string {
  const hash = createHash('sha256').update(inputs.join('|')).digest('hex')
  // Format as UUID v5-ish (the renderer only needs a stable opaque string,
  // not a strictly valid RFC4122 uuid). 8-4-4-4-12 layout.
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join('-')
}

/**
 * Codex stores function_call.arguments as a JSON-encoded string.
 * Parse to an object, falling back to { arguments: raw } if
 * parsing fails — so the Claude tool_use block always has a valid
 * input shape regardless of source quality.
 */
export function parseToolInput(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return { arguments: raw }
  }
}

/**
 * Normalize a Codex function-call output payload into a plain string
 * (for Claude tool_result.content) plus extracted metadata (for the
 * `codex` field on the block). Handles:
 *   - string output → { text: string, metadata: undefined }
 *   - array output with text blocks → concatenate; last metadata wins
 *   - custom_tool_call_output wrapped as JSON{output, metadata} → unwrap
 */
export function normalizeOutput(
  raw: unknown,
): { text: string; metadata?: Record<string, unknown> } {
  if (typeof raw === 'string') {
    // custom_tool_call_output often wraps JSON in the string
    if (raw.startsWith('{') && raw.endsWith('}')) {
      try {
        const parsed = JSON.parse(raw) as { output?: unknown; metadata?: unknown }
        if (typeof parsed.output === 'string') {
          return {
            text: parsed.output,
            metadata:
              typeof parsed.metadata === 'object' && parsed.metadata !== null
                ? (parsed.metadata as Record<string, unknown>)
                : undefined,
          }
        }
      } catch {
        // fall through to plain-string handling
      }
    }
    return { text: raw }
  }
  if (Array.isArray(raw)) {
    const parts: string[] = []
    let metadata: Record<string, unknown> | undefined
    for (const item of raw as Array<Record<string, unknown>>) {
      if (typeof item.text === 'string') parts.push(item.text)
      if (item.metadata && typeof item.metadata === 'object') {
        metadata = item.metadata as Record<string, unknown>
      }
    }
    return { text: parts.join('\n'), metadata }
  }
  return { text: '' }
}
```

---

## Mapping matrix (authoritative — both directions)

### Codex → Claude

| Codex record | Emits |
|---|---|
| `session_meta` | No entry emitted. Stored in conversion context (`sessionId`, `cwd`, `gitBranch`) and attached to every subsequent entry. Full payload preserved via sidecar on the first emitted entry's `_atp.source`. |
| `turn_context` | No entry emitted. Updates conversion context (latest `cwd`, `model`). Preserved via `_atp.source` on the next emitted entry. |
| `response_item` + `message` + `role='user'` | `{ type: 'user', message: { role: 'user', content: [{type:'text', text}] } }` per text block. |
| `response_item` + `message` + `role='assistant'` | `{ type: 'assistant', message: { role: 'assistant', content: [{type:'text', text}] } }` per `output_text` block. |
| `response_item` + `function_call` | `{ type: 'assistant', message: { content: [{type:'tool_use', id: call_id, name, input: parseToolInput(arguments) }] } }`. Namespace preserved via sidecar. |
| `response_item` + `function_call_output` | `{ type: 'user', message: { content: [{type:'tool_result', tool_use_id: call_id, content: normalized.text, is_error: exit_code!=0, codex: {exit_code, duration_seconds} }] } }`. |
| `response_item` + `custom_tool_call` | Same shape as `function_call` with `codex.kind: 'custom_tool_call'` on the tool_use block. |
| `response_item` + `custom_tool_call_output` | Same shape as `function_call_output` with `codex.kind: 'custom_tool_call_output'`. |
| `response_item` + `reasoning` | `{ type: 'assistant', message: { content: [{type:'thinking', thinking: summary.joined}] } }`. `encrypted_content` preserved via sidecar. |
| `response_item` + `local_shell_call` | Same shape as `function_call` with action.cmd joined into args. |
| `response_item` + `web_search_call` | `{ type: 'assistant', message: { content: [{type:'tool_use', name: 'WebSearch', input: action }] } }`. |
| `event_msg` + `exec_approval_request` | Synthetic `{ type: 'assistant', message: { content: [{type:'text', text: humanSummary(cmd, workdir)}] } }` so the approval prompt survives translation as visible content. |
| `event_msg` + other types | Dropped (render-only state, no transcript equivalent). Full event preserved in adjacent entry's sidecar pass-through is NOT done — these types are lost in lossy mode. |
| `compacted` | `{ type: 'system', subtype: 'compact_boundary', compactMetadata: payload }`. |

### Claude → Codex

| Claude entry | Emits |
|---|---|
| First emitted entry triggers | Prepending `session_meta` synthesized from entry's `sessionId`, `cwd`, `gitBranch`. |
| `type: 'user'` + content has text blocks | `response_item` with `message` payload, role=user, content=[{type:'input_text', text}]`. |
| `type: 'user'` + content has tool_result blocks | For each block: `response_item` with `function_call_output` payload. Uses `codex.exit_code`/`metadata` from the block if present. |
| `type: 'assistant'` + content has text blocks | `response_item` with `message` payload, role=assistant, content=[{type:'output_text', text}]`. |
| `type: 'assistant'` + content has tool_use blocks | For each block: `response_item` with `function_call` payload (or `custom_tool_call` if `codex.kind === 'custom_tool_call'`). `arguments` = JSON.stringify(input). |
| `type: 'assistant'` + content has thinking blocks | `response_item` with `reasoning` payload; text goes in summary. |
| `type: 'system'` + `subtype: 'compact_boundary'` | `compacted` line with compactMetadata as payload. |
| `type: 'system'` + other | Dropped in lossy mode. In fidelity mode, emit a `response_item` + `message` with role=system and full sidecar preservation. |
| File-history-snapshot, isMeta, isCompactSummary, etc. | Preserved ONLY via sidecar. No native Codex equivalent. |

---

## Task 1: Foundation — types, sidecar, util

**Files:**
- Modify: `src/types.ts`
- Modify: `src/sidecar.ts`
- Modify: `src/util.ts`

- [ ] **Step 1: Install dev deps (once, if not already)**

Run: `cd agent-transcript-parser && npm install`
Expected: typescript + tsx land in `node_modules`.

- [ ] **Step 2: Write `src/types.ts`**

Paste the full type block from the "Type shapes" section above. No logic, just types.

- [ ] **Step 3: Write `src/sidecar.ts`**

Paste the full sidecar primitives block from the "Sidecar primitives" section above.

- [ ] **Step 4: Write `src/util.ts`**

Paste the full utility helpers block from the "Utility helpers" section above.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/sidecar.ts src/util.ts package-lock.json
git commit -m "feat: foundation — types, sidecar, util helpers"
```

---

## Task 2: Codex → Claude (`toClaude.ts`) + fixtures

**Files:**
- Modify: `src/toClaude.ts`
- Create: `fixtures/codex/simple-chat.jsonl`
- Create: `fixtures/codex/tool-cycle.jsonl`
- Create: `fixtures/codex/approval-flow.jsonl`
- Create: `testing/verify.ts`

- [ ] **Step 1: Write `src/toClaude.ts`**

The file must:
- Export `toClaude(lines, opts?)` that iterates lines.
- For each line, if `readSidecar(line)?.origin === 'claude'`, emit `sidecar.source` directly (short-circuit).
- Otherwise dispatch on `line.type` + `payload.type`, calling internal mappers. Each mapper returns `ClaudeEntry[]`.
- Thread a `ConversionContext` through: `{ sessionId, cwd, gitBranch, parentUuid, index }`.
- For every emitted entry in non-short-circuit path: call `attachSidecar(entry, 'codex', line)` unless `opts.lossy`.
- Every emitted entry must have: `uuid` (derived via `stableUuid([sessionId, index, line.timestamp, payload.type])`), `parentUuid` (from context), `sessionId`, `timestamp` (copy from line), `cwd`/`gitBranch` (from context).

Internal mappers (all in the same file):
- `mapSessionMeta(ctx, line)` — updates ctx, returns `[]`.
- `mapTurnContext(ctx, line)` — updates ctx.cwd, returns `[]`.
- `mapMessage(ctx, line, payload)` — one entry per text content item, role preserved.
- `mapFunctionCall(ctx, line, payload)` — assistant+tool_use entry.
- `mapFunctionCallOutput(ctx, line, payload)` — user+tool_result entry; uses `normalizeOutput`.
- `mapCustomToolCall(ctx, line, payload)` — assistant+tool_use with `codex.kind:'custom_tool_call'`.
- `mapCustomToolCallOutput(ctx, line, payload)` — user+tool_result with `codex.kind:'custom_tool_call_output'`.
- `mapReasoning(ctx, line, payload)` — assistant+thinking entry; summary.joined for thinking.text.
- `mapExecApproval(ctx, line, payload)` — synthetic assistant text entry summarizing the request.
- `mapLocalShellCall`, `mapWebSearchCall` — similar to function_call with Action → input mapping.
- `mapCompacted(ctx, line)` — system+compact_boundary entry.
- `mapUnknown(ctx, line)` — dropped in lossy mode; in fidelity mode emit a synthetic `system` entry with `subtype: 'codex_unknown'` so round-trip still works.

After each entry is produced, update `ctx.parentUuid = entry.uuid` and `ctx.index++`.

- [ ] **Step 2: Capture three fixture transcripts**

From your `~/.codex/sessions/` directory pick three scenarios. Copy (sanitizing PII — replace paths with `/tmp/test`, strip absolute paths in prompts) into:
- `fixtures/codex/simple-chat.jsonl` — session_meta + a few user/assistant message exchanges, no tools
- `fixtures/codex/tool-cycle.jsonl` — session_meta + message + function_call + function_call_output + message
- `fixtures/codex/approval-flow.jsonl` — session_meta + exec_approval_request + subsequent exec_command_begin/end

- [ ] **Step 3: Write `testing/verify.ts` scaffold**

```ts
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { toClaude } from '../src/toClaude.js'
// toCodex comes in Task 3

const CODEX_DIR = join(import.meta.dirname, '..', 'fixtures', 'codex')
let failed = 0

function check(label: string, ok: boolean, detail?: string) {
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

// --- Codex → Claude smoke tests ---
for (const name of readdirSync(CODEX_DIR).filter(f => f.endsWith('.jsonl'))) {
  const codex = readJsonl(join(CODEX_DIR, name))
  const claude = toClaude(codex)
  check(`${name} converts without throwing`, true)
  check(`${name} emits at least one entry`, claude.length > 0)
  check(
    `${name} every entry has uuid + sessionId`,
    claude.every(e => typeof e.uuid === 'string' && typeof e.sessionId === 'string'),
  )
}

// Round-trip checks added in Task 3
if (failed > 0) process.exit(1)
console.log(`\n${failed === 0 ? 'All checks passed' : `${failed} failed`}`)
```

- [ ] **Step 4: Run verify**

Run: `npx tsx testing/verify.ts`
Expected: three `✓` lines per fixture (converts, emits, uuids). Exit 0.

If `tool-cycle.jsonl` doesn't emit a `tool_use` block, the `mapFunctionCall` path has a bug. Debug from there.

- [ ] **Step 5: Build**

Run: `npx tsc -p .`
Expected: `dist/` populates with `.js` + `.d.ts` files.

- [ ] **Step 6: Commit**

```bash
git add src/toClaude.ts fixtures/ testing/verify.ts
git commit -m "feat(toClaude): Codex → Claude conversion + three fixture scenarios + verify harness"
```

---

## Task 3: Claude → Codex (`toCodex.ts`) + round-trip

**Files:**
- Modify: `src/toCodex.ts`
- Create: `fixtures/claude/simple-chat.jsonl`
- Create: `fixtures/claude/tool-cycle.jsonl`
- Create: `fixtures/claude/multi-block-turn.jsonl`
- Modify: `testing/verify.ts`

- [ ] **Step 1: Write `src/toCodex.ts`**

Mirror `toClaude`'s structure:
- Short-circuit on `readSidecar(entry)?.origin === 'codex'` → emit `sidecar.source` directly.
- Otherwise walk `entry.message.content` (or `entry.message.content` if string) and emit one or more Codex lines per block.
- Prepend a `session_meta` line when the first non-system entry is emitted, synthesized from that entry's `sessionId`/`cwd`/`gitBranch` + a synthesized timestamp.
- Every emitted line gets `attachSidecar(line, 'claude', entry)` unless `opts.lossy`.

Internal mappers:
- `emitSessionMeta(entry)` — one `session_meta` line at the start of output.
- `mapUserEntry(entry)` — splits by content-block type:
  - text blocks → `message` payload role=user, `input_text` content items
  - tool_result blocks → `function_call_output` (or `custom_tool_call_output` if `codex.kind` is set)
- `mapAssistantEntry(entry)` — splits by content-block type:
  - text blocks → `message` payload role=assistant, `output_text` content items
  - tool_use blocks → `function_call` (or `custom_tool_call` per `codex.kind`); `arguments` = `JSON.stringify(input)`
  - thinking blocks → `reasoning` payload with summary = [{type:'text', text}]
- `mapSystemEntry(entry)` — compact_boundary → `compacted` line; other subtypes → dropped (fidelity mode preserves via sidecar).

- [ ] **Step 2: Capture three Claude fixtures**

From `~/.claude/projects/`:
- `fixtures/claude/simple-chat.jsonl` — user + assistant text exchanges, no tools
- `fixtures/claude/tool-cycle.jsonl` — user prompt + assistant tool_use + user tool_result + assistant text
- `fixtures/claude/multi-block-turn.jsonl` — assistant entry with MIXED text + tool_use in one message's content array (Claude-only shape that Codex splits across two response_items)

- [ ] **Step 3: Extend `testing/verify.ts` with round-trip**

Add after the existing Codex→Claude smoke section:

```ts
import { toCodex } from '../src/toCodex.js'
import { stripSidecar } from '../src/sidecar.js'

const CLAUDE_DIR = join(import.meta.dirname, '..', 'fixtures', 'claude')

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

// --- Claude round-trip: X → toCodex → toClaude === X ---
for (const name of readdirSync(CLAUDE_DIR).filter(f => f.endsWith('.jsonl'))) {
  const original = readJsonl(join(CLAUDE_DIR, name))
  const codex = toCodex(original)
  const roundTrip = toClaude(codex)
  check(`claude/${name} round-trip bytes match`, deepEqual(roundTrip, original))
}

// --- Codex round-trip: Y → toClaude → toCodex === Y ---
for (const name of readdirSync(CODEX_DIR).filter(f => f.endsWith('.jsonl'))) {
  const original = readJsonl(join(CODEX_DIR, name))
  const claude = toClaude(original)
  const roundTrip = toCodex(claude)
  check(`codex/${name} round-trip bytes match`, deepEqual(roundTrip, original))
}

// --- Lossy mode strips sidecar ---
for (const name of readdirSync(CODEX_DIR).filter(f => f.endsWith('.jsonl'))) {
  const codex = readJsonl(join(CODEX_DIR, name))
  const claudeLossy = toClaude(codex, { lossy: true })
  const hasAtp = claudeLossy.some(e =>
    JSON.stringify(e).includes('"_atp"'),
  )
  check(`codex/${name} lossy mode strips _atp`, !hasAtp)
}
```

- [ ] **Step 4: Run verify — expect round-trip failures initially**

Run: `npx tsx testing/verify.ts`
Expected: round-trip checks likely FAIL on the first run. For each, inspect `deepEqual` diff output and fix the sidecar short-circuit or mapping until all `✓`.

Common causes of round-trip failure:
- Sidecar attaching to synthesized entries (like prepended `session_meta`) — don't attach sidecar to synthesized lines, they're not from the original stream.
- Order differences — ensure mappers preserve emission order.
- Number vs string in timestamp — stick to ISO strings everywhere.

- [ ] **Step 5: Iterate until all green**

Loop: run verify → diagnose one failure → fix → re-run. Don't move on until every check passes.

- [ ] **Step 6: Commit**

```bash
git add src/toCodex.ts fixtures/claude/ testing/verify.ts
git commit -m "feat(toCodex): Claude → Codex conversion; round-trip fidelity proven by fixture harness"
```

---

## Task 4: Public surface + detectFormat + lossy polish

**Files:**
- Modify: `src/index.ts`
- Modify: `src/toClaude.ts` and `src/toCodex.ts` (export `ConvertOptions`)
- Modify: `README.md` (any corrections from what was learned during implementation)

- [ ] **Step 1: Write `src/index.ts`**

```ts
export { toClaude } from './toClaude.js'
export { toCodex } from './toCodex.js'

export type { ConvertOptions } from './toClaude.js'
// (ConvertOptions is declared in toClaude.ts and re-exported by toCodex.ts)

export {
  ATP_KEY,
  attachSidecar,
  readSidecar,
  stripSidecar,
} from './sidecar.js'
export type { AtpSidecar } from './sidecar.js'

export { detectFormat } from './detectFormat.js'

export type {
  ClaudeEntry,
  ClaudeContentBlock,
  ClaudeTextBlock,
  ClaudeToolUseBlock,
  ClaudeToolResultBlock,
  ClaudeThinkingBlock,
  ClaudeMessage,
} from './types.js'

export type {
  CodexRolloutLine,
  CodexResponseItemPayload,
  CodexEventMsgPayload,
  CodexSessionMetaPayload,
  CodexTurnContextPayload,
  CodexMessagePayload,
  CodexFunctionCallPayload,
  CodexFunctionCallOutputPayload,
  CodexCustomToolCallPayload,
  CodexCustomToolCallOutputPayload,
  CodexReasoningPayload,
} from './types.js'
```

- [ ] **Step 2: Add `src/detectFormat.ts` (small new file — acceptable scope creep for the final commit)**

```ts
import type { ClaudeEntry, CodexRolloutLine } from './types.js'

export function detectFormat(
  input: readonly unknown[],
): 'claude' | 'codex' | 'unknown' {
  if (input.length === 0) return 'unknown'
  const first = input[0] as Record<string, unknown>
  if (!first || typeof first !== 'object') return 'unknown'

  // Codex: every line has { timestamp, type, payload } with payload
  // being an object. 'type' is a small enumeration.
  if (
    'payload' in first &&
    typeof first.payload === 'object' &&
    ('type' in first) &&
    typeof first.type === 'string'
  ) {
    return 'codex'
  }

  // Claude: every entry has { type, uuid, ... } with uuid as string.
  // No top-level 'payload' field.
  if (
    'uuid' in first &&
    typeof first.uuid === 'string' &&
    'type' in first &&
    typeof first.type === 'string'
  ) {
    return 'claude'
  }

  return 'unknown'
}
```

- [ ] **Step 3: Run the full verify once more**

Run: `npx tsx testing/verify.ts`
Expected: every check passes, exit 0.

- [ ] **Step 4: Final build**

Run: `npx tsc -p .`
Expected: `dist/index.js`, `dist/index.d.ts`, plus all the other compiled files. No errors.

- [ ] **Step 5: Update README if implementation drifted from spec**

Review `README.md`. Any design decision you made differently during implementation (e.g., you discovered `reasoning` blocks can't round-trip cleanly and need a sidecar) — update the README's decision list to reflect reality.

- [ ] **Step 6: Commit + push**

```bash
git add src/index.ts src/detectFormat.ts README.md
git commit -m "feat: public API — detectFormat, typed exports, final README pass"
git push
```

---

## Self-Review

**Spec coverage**

| Spec point from README | Task |
|---|---|
| `toClaude(codexLines)` | Task 2 |
| `toCodex(claudeEntries)` | Task 3 |
| `detectFormat(input)` | Task 4 |
| `_atp` sidecar attach/read/strip | Task 1 |
| Round-trip invariant (both directions) | Task 3 Step 3 |
| Lossy mode option | Task 3 Step 3 (verification) |
| Every mapping in the Codex→Claude table | Task 2 Step 1 |
| Every mapping in the Claude→Codex table | Task 3 Step 1 |
| Multi-block turn edge case | Task 3 Step 2 (fixture) |
| Compaction/summary | types.ts + toCodex mapSystemEntry |
| Reasoning/thinking blocks | Task 2 mapReasoning + Task 3 mapAssistantEntry thinking branch |
| Approval events (exec_approval_request) | Task 2 mapExecApproval |

**Type consistency**

- `ATP_KEY = '_atp'` used in both `sidecar.ts` (constant) and `types.ts` (literal type); single source via the `as const` assertion.
- `ClaudeEntry.message?` is optional to accommodate `type: 'system'` and `type: 'file-history-snapshot'` which don't carry a message.
- `CodexRolloutLine.payload` varies by `type`; each branch uses its matching payload type — consistent across toClaude + toCodex.
- `ConvertOptions` declared in `toClaude.ts`, re-exported from `toCodex.ts` (same shape, one declaration).

**Placeholder scan**

- No "TBD" / "implement later" text.
- Every code block contains real code.
- "Common causes of round-trip failure" in Task 3 Step 4 lists concrete failure modes + diagnosis paths, not handwaves.

**Risks**

1. **Unknown response_item types.** Codex may emit types we haven't seen (e.g. future additions). The `mapUnknown` handler in Task 2 wraps them in a synthetic system entry so round-trip still works via sidecar — but semantic rendering is lost. Lives as an open field on `CodexResponseItemPayload` (the `{ type: string; [k: string]: unknown }` catch-all).

2. **Order sensitivity in round-trip.** Claude's multi-block assistant turn (text + tool_use + text) becomes 3 separate Codex `response_item`s. On the reverse trip those become 3 separate Claude entries, NOT one entry with 3 blocks. This means `toCodex(toClaude(codexMultiTurn))` round-trips cleanly, but `toClaude(toCodex(claudeMultiBlockTurn))` emits 3 entries vs the original 1. Round-trip ONLY works when both ends use the sidecar short-circuit. Document this in README — it's already covered by "multi-block-turn.jsonl" fixture in Task 3.

3. **Timestamp fidelity.** Codex timestamps are ISO strings; Claude timestamps are ISO strings. We pass through verbatim. No arithmetic, no reformatting.

4. **Encrypted reasoning content.** `CodexReasoningPayload.encrypted_content` is an opaque blob. We preserve it in the sidecar but cannot render or re-generate it. Reasoning → Claude thinking block uses only the `summary` field for visible content.

---

## Done when

- `npx tsx testing/verify.ts` passes all checks (Codex→Claude smoke, Claude→Codex→Claude round-trip, Codex→Claude→Codex round-trip, lossy strips _atp).
- `npx tsc -p .` builds clean.
- 4 commits pushed to `main`.
- README's decision list matches reality of what got built.

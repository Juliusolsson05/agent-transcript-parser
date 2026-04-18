# Ghost records

A **ghost** is a transcript record tagged `_atp.origin = 'ghost'` that stands in for a real record that does not yet exist, may never exist, or is expected to be supplied by another producer. Ghosts are **valid JSONL** in either Claude or Codex format — native parsers ignore unknown fields, so a ghost-tagged file loads unchanged in `claude --resume` or a Codex rollout reload.

Ghost sits next to the existing `claude` / `codex` / `synthesized` origins in the sidecar as a first-class citizen: typed, reconcilable, and explicitly skipped by both converters.

## Why it's useful

Transcripts are usually treated as a record of what **happened**. Ghost adds a record of what **is happening**, what **should happen**, or what **a tool thinks is happening**. That distinction lets tools cooperate around a shared JSONL file without stepping on each other.

The general pattern is any scenario with **two producers and a durability gap**:

- **Live UIs over batched writers.** Agent CLIs (including Claude Code itself) write transcript JSONL lazily — the upstream writer batches every 100 ms, or 10 ms for remote sessions. A UI that renders from JSONL only has a visible gap; a UI that renders from live state only duplicates the record once upstream arrives. Ghost is the bridge: render from a merged view, let real replace ghost.

- **Optimistic / speculative writes.** Show what a tool is about to do before the authoritative system records it. If the authoritative write lands, ghost is superseded. If it fails, ghost stays as a forensic record of the attempt.

- **Multi-producer sessions.** A proxy, an IDE plugin, and the CLI itself can all observe the same session. One produces authoritative records, others produce ghosts, reconciliation happens at read time.

- **Offline / local-first edits.** Let users edit or draft turns while disconnected from the CLI. Commit them later by calling `supersedeGhost` with the real uuid, or keep them as ghosts.

- **Streaming ingestion.** Pipelines that fold external signals (speech-to-text, external tool output, screen scraping) into a transcript before an authoritative writer confirms.

- **Failure forensics.** When a turn crashes mid-flight, the ghost is the surviving record of what was observed, even if the CLI never flushed it to its own JSONL.

- **Test harnesses.** Inject predictable ghost turns into a transcript to exercise reconcilers, renderers, or converters without needing a live agent run.

The unifying property: **ghost lets a record exist with explicit provenance that it is not authoritative, so downstream tools can merge, replace, or discard it without guessing.**

## Lifecycle

```
created ──► updated* ──► superseded
                  \──► orphaned
```

- **created** — first write. `createdAt = updatedAt = now`.
- **updated** — any revised snapshot of the same block. Same uuid, new content, bumped `updatedAt`.
- **superseded** — an authoritative record has taken over. `supersededBy` points at the real uuid.
- **orphaned** — the expected authoritative record never arrived within the consumer's timeout. `orphanedAt` is set. The ghost remains readable and renders as usual; UIs typically flag orphans so users know the content is provisional.

Ghosts are **append-only JSONL with deterministic uuids** (`g-<turnId>-<blockIndex>`). Consumers append freely; readers fold the log via `reduceGhostLog` and the last-write-wins rule delivers the freshest snapshot per uuid. There is no in-place mutation path, no file rewrite, no lock file.

## Reconciliation

Three-step merge: authoritative first, then un-superseded ghosts, then orphans flagged. The library ships `mergeWithUpstream` as a reference implementation; consumers can write their own — the primitives are pure.

Matching rules are intentionally layered so consumers pick the tightest one that fits:

1. **Exact `supersededBy`**, set by the consumer when it sees the authoritative record. This is the only rule the library applies by default.
2. **Tool-correlation id equality** (e.g. `tool_use_id`) for tool blocks. Consumer applies this check and calls `supersedeGhost` before merging.
3. **Content hash** over normalized text for assistant blocks. Same pattern — consumer owns the comparison and calls `supersedeGhost`.

The rationale for keeping rules 2–3 out of the library is that "same content" is use-case dependent. Some consumers consider whitespace-only changes equivalent; some don't. Some want to treat partial text matches as a supersedence signal; some don't. Forcing a single rule into `mergeWithUpstream` would silently corrupt transcripts for consumers whose notion of equality differs.

## Guarantees and non-guarantees

**atp guarantees:**

- Ghost records round-trip losslessly through read/reduce/merge cycles.
- Both converters (`toClaude`, `toCodex`) skip ghosts on export — they are a runtime artifact, not durable transcript content. A transcript that contained ghosts on input produces a ghost-free output on conversion.
- `_atp.context` is carried through read/reduce/merge unchanged. The library never reads it.
- Ghost uuids never collide with real Claude or Codex uuids. The `g-` prefix is not produced by `crypto.randomUUID()`.

**atp does not guarantee:**

- Ordering of ghosts vs authoritative records on disk. Consumers are expected to merge by timestamp or sequence, not file position.
- Cross-process write safety. Consumers own persistence. If two producers want to write ghosts to the same file, they coordinate.
- Visual rendering. atp stays out of the UI layer entirely.

## When NOT to use ghost

- When the record is authoritative — use `origin: 'claude'` or `origin: 'codex'`.
- When the record is fabricated for round-trip padding only — use the existing `synthesized` origin.
- When the record must be hidden from native parsers — ghost is visible to any parser that reads unknown fields. If you need true hiding, ghost is the wrong tool.

## API

All exports are also available from the package root (`agent-transcript-parser`) for convenience.

```ts
import {
  createGhost,
  updateGhost,
  supersedeGhost,
  orphanGhost,
  reduceGhostLog,
  mergeWithUpstream,
  ghostUuid,
  isGhostUuid,
  isGhost,
  ghostSidecar,
} from 'agent-transcript-parser'

import type {
  GhostEntry,
  AtpGhostSidecar,
  CreateGhostParams,
  MergeOptions,
} from 'agent-transcript-parser'
```

### `ghostUuid(turnId, blockIndex): string`

Deterministic uuid scheme: `g-<turnId>-<blockIndex>`. Consumers never need to pass uuids around — `createGhost`, `updateGhost`, `supersedeGhost`, and `orphanGhost` all route through the same scheme.

### `createGhost(params: CreateGhostParams): GhostEntry`

Mint a fresh ghost. See the type for the parameter list; the short version is `(sessionId, turnId, blockIndex, role, content, parentUuid?, context?)`.

### `updateGhost(prev, content, now?): GhostEntry`

Return a revised ghost with new content and a bumped `updatedAt`. Pure function; the input is not mutated.

### `supersedeGhost(prev, realUuid, now?): GhostEntry`

Mark a ghost as superseded by an authoritative upstream uuid. Append the returned record to the ghost log as the final state for that block.

### `orphanGhost(prev, now?): GhostEntry`

Mark a ghost as orphaned (no authoritative record will arrive).

### `reduceGhostLog(entries): Map<string, GhostEntry>`

Fold an append-only stream of writes into the current state map. Non-ghost entries are silently skipped so you can feed a mixed JSONL file.

### `mergeWithUpstream(upstream, ghosts, opts?): ClaudeEntry[]`

Produce a single render-ordered sequence: authoritative entries first, then un-superseded ghosts in `updatedAt` order. Options control whether to keep superseded ghosts in the tail (forensic UIs) or drop orphaned ghosts entirely.

## Example

```ts
import {
  createGhost,
  updateGhost,
  supersedeGhost,
  reduceGhostLog,
  mergeWithUpstream,
  toCodex,
} from 'agent-transcript-parser'

// --- Live layer (producer side) ---
//
// As the assistant streams a block, write ghost snapshots to disk.
// The ghost log is a second JSONL file owned by the consumer — NOT
// the authoritative transcript the CLI writes.

let ghost = createGhost({
  sessionId: 'sess-42',
  turnId: 'msg_abc',
  blockIndex: 0,
  role: 'assistant',
  content: [{ type: 'text', text: 'Looking at…' }],
})
appendToGhostLog(ghost)

ghost = updateGhost(ghost, [
  { type: 'text', text: 'Looking at the source now.' },
])
appendToGhostLog(ghost)

// --- Authoritative write lands ---
//
// The upstream CLI wrote its own transcript entry with uuid
// `real-uuid-xyz`. Mark the ghost as superseded and append the
// final state record.

ghost = supersedeGhost(ghost, 'real-uuid-xyz')
appendToGhostLog(ghost)

// --- Render side (consumer) ---
//
// Read both the authoritative transcript and the ghost log; fold
// ghosts; merge. The resulting entry list is what the UI renders.

const upstream = readAuthoritativeTranscript()
const ghosts = reduceGhostLog(readGhostLog())
const rendered = mergeWithUpstream(upstream, ghosts)

// --- Export side ---
//
// Converters skip ghosts. Exporting a session mid-flight produces
// a clean Codex rollout without placeholders.

const codex = toCodex(upstream) // ghosts never reach toCodex; but
                                // feeding a mixed list is also safe.
```

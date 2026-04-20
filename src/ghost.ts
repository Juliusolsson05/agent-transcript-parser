// Ghost records — a general-purpose primitive for provisional
// transcript entries that reconcile against authoritative ones.
//
// -----------------------------------------------------------------------------
// WHY this exists
// -----------------------------------------------------------------------------
//
// Both Claude and Codex transcripts are usually treated as a record of what
// HAPPENED. That framing works fine for a single authoritative writer, but
// breaks the moment a second producer wants to participate in the same file:
//
//   * A live UI rendering a turn while the CLI is still batching its JSONL
//     writes (claude-code-src/full/utils/sessionStorage.ts batches every
//     100 ms, 10 ms remote). The UI needs a provisional entry that can bow
//     out once the real record lands.
//   * A speculative writer emitting what it INTENDS to do, so a separate
//     authoritative system can confirm or reject it.
//   * An offline editor drafting turns that get committed later.
//   * A proxy logger coexisting with an IDE plugin, each observing the same
//     session from a different angle.
//   * A streaming ingestion pipeline (speech-to-text, external tool output)
//     folding signals into a transcript before an authoritative writer sees
//     them.
//
// Every one of those scenarios wants the same thing: "emit a record, tag it
// as non-authoritative, let the reconciler replace or discard it when the
// authoritative version arrives." That is what a ghost is.
//
// -----------------------------------------------------------------------------
// Design invariants
// -----------------------------------------------------------------------------
//
//  1. A ghost is a valid ClaudeEntry. Native parsers ignore unknown fields,
//     so the tag lives in `_atp` and the rest of the record is shaped like
//     any other Claude entry. Files with ghosts still load cleanly in
//     `claude --resume`, Codex rollout reload, or any third-party tool that
//     reads either provider's JSONL.
//
//  2. Ghost uuids are deterministic from `(turnId, blockIndex)`. This is the
//     whole reason ghost logs can be append-only: updating a block means
//     appending another ghost entry with the same uuid, and readers pick
//     the freshest one by `updatedAt`. No in-place mutation, no file
//     rewrites, no lock files.
//
//  3. Converters (`toClaude`, `toCodex`) SKIP ghosts. They are a runtime
//     artifact. Exporting a transcript that contains ghosts to the other
//     provider would embed placeholders into durable history — wrong.
//
//  4. Reconciliation is consumer-driven. atp ships a reference merger
//     (`mergeWithUpstream`) that handles the common cases, but the library
//     never phones home, never tails a file, never opens a socket. All IO
//     is the caller's responsibility.
//
//  5. No cc-shell vocabulary bleeds in. This file is part of a standalone
//     library; it must read sensibly to a consumer that has never heard of
//     cc-shell, claude-code-headless, codex-headless, or any specific UI.

import { ATP_KEY } from './types.js'
import type {
  AtpGhostSidecar,
  ClaudeContentBlock,
  ClaudeEntry,
  ClaudeRole,
  GhostEntry,
} from './types.js'
import { ghostSidecar, isGhost } from './sidecar.js'

// -----------------------------------------------------------------------------
// ghostUuid — deterministic id scheme
// -----------------------------------------------------------------------------

/**
 * Mint a ghost uuid from the turn id and block index.
 *
 * WHY deterministic instead of random:
 *
 *   Ghost logs are append-only JSONL. The reducer's last-write-wins rule
 *   only works if repeated snapshots for the same block share a key. A
 *   random uuid per write would force the reducer to invent its own
 *   grouping — a task with no non-heuristic solution for non-adjacent
 *   writes.
 *
 *   The `g-` prefix ensures a ghost uuid can never collide with a Claude
 *   or Codex uuid in the same file. Claude uses `crypto.randomUUID()`
 *   which produces RFC-4122 uuids; those never start with `g-`.
 *
 * The uuid is stable under process restarts, so a consumer that crashes
 * and resumes can replay its ghost log without duplicate keys.
 */
export function ghostUuid(turnId: string, blockIndex: number): string {
  if (!turnId) throw new Error('ghostUuid: turnId is required')
  if (!Number.isFinite(blockIndex)) {
    throw new Error('ghostUuid: blockIndex must be a finite number')
  }
  return `g-${turnId}-${blockIndex}`
}

/**
 * Quick check for the ghost uuid scheme. Useful for consumers that want
 * to reject a ghost uuid being passed where a real uuid is expected
 * (e.g. when wiring `parentUuid` chains).
 */
export function isGhostUuid(uuid: string | null | undefined): boolean {
  return typeof uuid === 'string' && uuid.startsWith('g-')
}

// -----------------------------------------------------------------------------
// createGhost / updateGhost / supersedeGhost / orphanGhost
// -----------------------------------------------------------------------------

/**
 * Parameters for minting a fresh ghost. The parameter list mirrors the
 * fields a live layer typically already has on hand — it does NOT
 * require the consumer to fabricate a full ClaudeEntry.
 */
export type CreateGhostParams = {
  /** Session id this ghost belongs to. Required because the underlying
   *  ClaudeEntry shape requires it, and because downstream tools key
   *  multi-session log collections by sessionId. */
  sessionId: string
  /** Logical turn id — message id on Claude, response id on Codex. The
   *  ghost reconciler uses this + blockIndex to line up ghosts with
   *  real upstream records. */
  turnId: string
  /** Zero-based position within the turn. Each block gets its own
   *  ghost; repeat writes for the same (turnId, blockIndex) update
   *  that ghost rather than creating a new one. */
  blockIndex: number
  /** Role of the turn the ghost belongs to. Most ghosts are
   *  'assistant' (previewing an in-flight model reply) but 'user'
   *  ghosts are legitimate for consumer-side speculative writes. */
  role: ClaudeRole
  /** Content blocks rendered so far. May be partial — the block list
   *  will be refreshed via `updateGhost` as more content arrives. */
  content: ClaudeContentBlock[]
  /** Parent uuid in the Claude chain. Consumers that don't track a
   *  parent chain can pass null. */
  parentUuid?: string | null
  /** Free-form consumer metadata, carried through untouched. atp
   *  never reads this. */
  context?: Record<string, unknown>
  /** Optional override for `createdAt` / `updatedAt`. Tests use this
   *  to pin timestamps; production callers leave it unset. */
  now?: number
}

/**
 * Create a fresh ghost entry.
 *
 * The returned record has:
 *   - `_atp.origin === 'ghost'`
 *   - `uuid === ghostUuid(turnId, blockIndex)`
 *   - `createdAt === updatedAt === now`
 *
 * Consumers append this record to their ghost log. Subsequent updates
 * call `updateGhost` to produce a revised record with the same uuid
 * and append it; the reducer picks the freshest.
 */
export function createGhost(params: CreateGhostParams): GhostEntry {
  const now = params.now ?? Date.now()
  const uuid = ghostUuid(params.turnId, params.blockIndex)
  const sidecar: AtpGhostSidecar = {
    origin: 'ghost',
    turnId: params.turnId,
    blockIndex: params.blockIndex,
    createdAt: now,
    updatedAt: now,
    ...(params.context !== undefined ? { context: params.context } : {}),
  }
  // Timestamp lives on the ClaudeEntry as an ISO-8601 string; the
  // numeric epoch is on the sidecar. Both forms are carried because
  // downstream renderers key off `timestamp` (to order turns) while
  // the reducer keys off `updatedAt` (to pick the freshest snapshot).
  const entry: GhostEntry = {
    type: params.role === 'user' ? 'user' : 'assistant',
    uuid,
    parentUuid: params.parentUuid ?? null,
    sessionId: params.sessionId,
    timestamp: new Date(now).toISOString(),
    message: {
      role: params.role,
      content: params.content,
    },
    [ATP_KEY]: sidecar,
  }
  return entry
}

/**
 * Return a revised ghost with new content and a bumped `updatedAt`.
 * The uuid, createdAt, turnId, blockIndex, and consumer context are
 * preserved — this is strictly a snapshot update, not a new ghost.
 *
 * WHY return a new object instead of mutating:
 *
 *   Consumers may have already passed the previous snapshot elsewhere
 *   (a renderer, an IPC channel, a log collector). Mutation would
 *   silently corrupt those captures. Returning a fresh object keeps
 *   this library a pure-function set.
 */
export function updateGhost(
  prev: GhostEntry,
  content: ClaudeContentBlock[],
  now: number = Date.now(),
): GhostEntry {
  const sidecar: AtpGhostSidecar = {
    ...prev._atp,
    updatedAt: now,
  }
  return {
    ...prev,
    timestamp: new Date(now).toISOString(),
    message: {
      ...(prev.message ?? { role: 'assistant', content: [] }),
      role: prev.message?.role ?? 'assistant',
      content,
    },
    [ATP_KEY]: sidecar,
  }
}

/**
 * Mark a ghost as superseded by a real upstream uuid. Returns a new
 * ghost entry with `supersededBy` set; consumers append this as the
 * final state record for the ghost.
 *
 * After this, the reducer still returns the ghost in its current
 * state map, but `mergeWithUpstream` will prefer the upstream record
 * whenever one is present in the upstream list. Keeping the final
 * superseded ghost on disk is intentional: forensic tools can still
 * recover "what the live layer thought was happening" even after the
 * authoritative record took over.
 */
export function supersedeGhost(
  prev: GhostEntry,
  realUuid: string,
  now: number = Date.now(),
): GhostEntry {
  if (!realUuid) throw new Error('supersedeGhost: realUuid is required')
  const sidecar: AtpGhostSidecar = {
    ...prev._atp,
    updatedAt: now,
    supersededBy: realUuid,
  }
  return {
    ...prev,
    timestamp: new Date(now).toISOString(),
    [ATP_KEY]: sidecar,
  }
}

/**
 * Mark a ghost as orphaned — the expected authoritative record never
 * arrived within the consumer's timeout. Orphaned ghosts keep rendering
 * (they're the only evidence the block ever existed) but UIs typically
 * flag them so the user knows the content is provisional.
 */
export function orphanGhost(
  prev: GhostEntry,
  now: number = Date.now(),
): GhostEntry {
  const sidecar: AtpGhostSidecar = {
    ...prev._atp,
    updatedAt: now,
    orphanedAt: now,
  }
  return {
    ...prev,
    timestamp: new Date(now).toISOString(),
    [ATP_KEY]: sidecar,
  }
}

// -----------------------------------------------------------------------------
// reduceGhostLog — fold an append-only log into current state
// -----------------------------------------------------------------------------

/**
 * Reduce a stream of ghost writes into the current state map.
 *
 * Ghost writes are append-only JSONL with deterministic uuids, so the
 * "current" ghost for a given uuid is simply the freshest one by
 * `updatedAt`. Ties (same timestamp) are resolved by keeping the later
 * entry in the input order, which mirrors what a JSONL tail reader
 * would see on disk.
 *
 * Non-ghost entries in the input are silently skipped — callers can
 * feed a mixed stream (e.g. a whole JSONL file) without pre-filtering.
 */
export function reduceGhostLog(
  entries: readonly ClaudeEntry[],
): Map<string, GhostEntry> {
  const out = new Map<string, GhostEntry>()
  for (const entry of entries) {
    if (!isGhost(entry)) continue
    const existing = out.get(entry.uuid)
    if (!existing) {
      out.set(entry.uuid, entry)
      continue
    }
    const a = existing._atp.updatedAt
    const b = entry._atp.updatedAt
    // Equal timestamps: later-in-stream wins. That matches tail -f
    // semantics and avoids a subtle bug where two same-ms snapshots
    // silently flip based on Map iteration order.
    if (b >= a) out.set(entry.uuid, entry)
  }
  return out
}

/**
 * Fold a ghost log and drop every ghost whose final state is
 * `supersededBy`.
 *
 * WHY this exists as a separate helper:
 *
 *   Some consumers (cc-shell is the canonical one) only want the
 *   provisional-and-still-live set of ghosts on resume. They never
 *   want the forensic "we rendered X but upstream confirmed Y" rows
 *   that the default `reduceGhostLog` + `mergeWithUpstream` path
 *   leaves visible. Giving those consumers a tightly-scoped reader
 *   keeps the default log reducer honest (it still returns every
 *   ghost in its final state, forensic or not) while letting the
 *   caller pre-trim the set before merging.
 *
 *   Pair with {@link MergeOptions.trustSupersededFlag} if you hold
 *   only a recent tail of upstream and cannot prove the target
 *   uuid is visible — the two options together ensure reconciled
 *   ghosts stay reconciled across disk-reload boundaries.
 *
 * Orphaned ghosts are kept — they are the only record that the
 * block ever existed. Superseded ghosts are dropped because their
 * content is covered by the committed upstream entry.
 */
export function reduceGhostLogSansSuperseded(
  entries: readonly ClaudeEntry[],
): Map<string, GhostEntry> {
  const full = reduceGhostLog(entries)
  for (const [uuid, ghost] of full) {
    if (ghost._atp.supersededBy !== undefined) full.delete(uuid)
  }
  return full
}

// -----------------------------------------------------------------------------
// mergeWithUpstream — render-time merge of upstream + ghost state
// -----------------------------------------------------------------------------

/**
 * Options for {@link mergeWithUpstream}. All flags are opt-in so the
 * default behavior stays predictable.
 */
export type MergeOptions = {
  /** When true, keep superseded ghosts in the output tail (flagged).
   *  Useful for forensic UIs that want to show "we rendered X but
   *  upstream confirmed Y." Default false: superseded ghosts are
   *  dropped from the render set entirely. */
  keepSupersededGhosts?: boolean
  /** When true, drop orphaned ghosts from the output. Default false:
   *  orphans keep rendering because they're the only record of that
   *  block ever existing. */
  dropOrphanedGhosts?: boolean
  /** When true, a ghost with `supersededBy` set is treated as
   *  superseded regardless of whether its target uuid appears in
   *  `upstream`. Opt-in because the default behaviour (drop only
   *  when the target is visible) is the safer forensic story: if
   *  "X was replaced by Y" but we can't see Y, we keep showing X.
   *
   *  This flag exists for consumers like cc-shell that only ever
   *  hold a RECENT TAIL of the upstream transcript — the target uuid
   *  might be a committed entry from two hours ago that simply isn't
   *  in the loaded slice. Without this flag, every ghost that
   *  actually got reconciled in a prior session resurfaces on resume
   *  as an orphan because its target is outside the window.
   *
   *  Mutually exclusive with `keepSupersededGhosts` — setting both
   *  is a caller error and the keep flag wins (no silent drop). */
  trustSupersededFlag?: boolean
}

/**
 * Merge an authoritative upstream list with the current ghost state map
 * and produce a single render-ordered sequence of ClaudeEntries.
 *
 * Matching rules, in precedence order:
 *   1. If a ghost's `supersededBy` equals an upstream entry's uuid, the
 *      upstream entry wins and the ghost is dropped (unless
 *      `keepSupersededGhosts` is set).
 *   2. If no ghost is explicitly superseded for a given upstream entry,
 *      the upstream entry still wins — it just means the consumer
 *      hasn't called `supersedeGhost` yet, and the reconciler can't
 *      guess a content match without provider-specific knowledge.
 *      Consumers that want tighter matching (by tool_use_id, by text
 *      hash) apply those checks BEFORE calling merge and set
 *      `supersededBy` themselves.
 *
 * Ordering: upstream entries keep their incoming order; un-superseded
 * ghosts append after the upstream tail, ordered by `updatedAt` and
 * then by (turnId, blockIndex) as a tie-breaker.
 */
export function mergeWithUpstream(
  upstream: readonly ClaudeEntry[],
  ghosts: ReadonlyMap<string, GhostEntry>,
  opts: MergeOptions = {},
): ClaudeEntry[] {
  const keepSuperseded = opts.keepSupersededGhosts === true
  const trustSuperseded = opts.trustSupersededFlag === true && !keepSuperseded
  const dropOrphaned = opts.dropOrphanedGhosts === true

  // Index upstream uuids so we can ask "is this ghost's supersededBy
  // satisfied?" in O(1). Skipped when `trustSupersededFlag` is set
  // because in that mode we don't need the target uuid to be visible.
  const upstreamUuids = new Set<string>()
  if (!trustSuperseded) {
    for (const entry of upstream) {
      if (typeof entry.uuid === 'string' && entry.uuid.length > 0) {
        upstreamUuids.add(entry.uuid)
      }
    }
  }

  const trailing: GhostEntry[] = []
  for (const ghost of ghosts.values()) {
    const sidecar = ghost._atp
    const supersededBy = sidecar.supersededBy
    const hasSupersededFlag = typeof supersededBy === 'string'
    // With `trustSupersededFlag`, the mere presence of `supersededBy`
    // marks the ghost as reconciled. Default behaviour still verifies
    // the target is in-upstream so forensic "X was replaced but we
    // can't show Y" rows stay visible.
    const isSuperseded = hasSupersededFlag && (
      trustSuperseded || upstreamUuids.has(supersededBy)
    )
    if (isSuperseded && !keepSuperseded) continue
    if (sidecar.orphanedAt !== undefined && dropOrphaned) continue
    trailing.push(ghost)
  }

  trailing.sort((a, b) => {
    const ua = a._atp.updatedAt
    const ub = b._atp.updatedAt
    if (ua !== ub) return ua - ub
    if (a._atp.turnId !== b._atp.turnId) {
      return a._atp.turnId < b._atp.turnId ? -1 : 1
    }
    return a._atp.blockIndex - b._atp.blockIndex
  })

  return [...upstream, ...trailing]
}

// -----------------------------------------------------------------------------
// Utility re-exports
// -----------------------------------------------------------------------------

// Re-exported here so consumers importing from `./ghost` get the full
// working set without a second import from `./sidecar`. The originals
// still live next to the other sidecar utilities for discoverability.
export { ghostSidecar, isGhost } from './sidecar.js'
export type {
  ClaudeContentBlock,
  ClaudeTextBlock,
  ClaudeThinkingBlock,
  ClaudeToolUseBlock,
  GhostEntry,
} from './types.js'

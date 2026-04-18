// The `_atp` field convention: attach original record for lossless
// round-trip; read/strip utilities used by toClaude / toCodex.
//
// Both Claude and Codex parsers ignore unknown top-level fields on
// transcript records (neither does strict-schema validation). That
// means we can stash a WHOLE original record under `_atp` without
// disturbing either native consumer. On the reverse trip we detect
// the sidecar and emit `_atp.source` verbatim, skipping the mapping
// pipeline entirely and guaranteeing byte-identical output.

import {
  ATP_KEY,
  type AtpGhostSidecar,
  type AtpSidecar,
  type ClaudeEntry,
  type CodexRolloutLine,
  type GhostEntry,
  type WithAtp,
} from './types.js'

export { ATP_KEY } from './types.js'
export type { AtpGhostSidecar, AtpSidecar, GhostEntry } from './types.js'

/**
 * Attach a sidecar to a freshly-emitted record. Returns a new object;
 * does not mutate the input.
 *
 * `source` holds the ORIGINAL record (Claude entry or Codex rollout
 * line) that this output was derived from. On round-trip the reverse
 * converter reads the sidecar and emits `source` directly.
 */
export function attachSidecar<T extends object>(
  record: T,
  origin: AtpSidecar['origin'],
  source: ClaudeEntry | CodexRolloutLine,
): WithAtp<T> {
  return { ...record, [ATP_KEY]: { origin, source } } as WithAtp<T>
}

/**
 * Read and validate a sidecar. Returns null when missing or
 * malformed. Defensive against hand-edited transcripts with a
 * partial or invented `_atp` field.
 *
 * Four origins are recognized:
 *   - `claude` / `codex` — authoritative records from either provider.
 *     Both carry `source` (single or array) for lossless round-trip.
 *   - `synthesized` — converter-emitted boilerplate (e.g. synthesized
 *     session_meta). No `source`.
 *   - `ghost` — a provisional record awaiting reconciliation. No
 *     `source`, but MUST carry `turnId`, `blockIndex`, `createdAt`,
 *     and `updatedAt`. See `./ghost.ts` and `docs/ghost.md`.
 */
export function readSidecar<T extends WithAtp<object>>(
  record: T,
): AtpSidecar | null {
  const raw = (record as Record<string, unknown>)[ATP_KEY]
  if (!raw || typeof raw !== 'object') return null
  const s = raw as AtpSidecar
  if (s.origin === 'synthesized') return s
  if (s.origin === 'ghost') {
    // Ghosts need enough metadata for the reconciler to line them up
    // against real upstream records. A malformed ghost (missing
    // turnId / blockIndex / timestamps) is worse than no sidecar at
    // all because it would read as "belongs to some turn but we
    // don't know which" — safer to reject here and let the consumer
    // treat the record as an ordinary ClaudeEntry.
    const g = s as AtpGhostSidecar
    if (typeof g.turnId !== 'string' || g.turnId.length === 0) return null
    if (typeof g.blockIndex !== 'number' || !Number.isFinite(g.blockIndex)) return null
    if (typeof g.createdAt !== 'number' || !Number.isFinite(g.createdAt)) return null
    if (typeof g.updatedAt !== 'number' || !Number.isFinite(g.updatedAt)) return null
    return g
  }
  if (s.origin !== 'claude' && s.origin !== 'codex') return null
  if (!('source' in s) || s.source === null || s.source === undefined) {
    return null
  }
  // `source` may be an object (single) or an array (coalesced post-pass).
  // Both are valid — downstream iterates uniformly via `sidecarSources()`.
  if (typeof s.source !== 'object') return null
  return s
}

/**
 * Type guard: is this record a ghost?
 *
 * Equivalent to `readSidecar(record)?.origin === 'ghost'` but with a
 * narrowed return type so TypeScript understands `record._atp` is an
 * {@link AtpGhostSidecar} inside the guarded branch.
 */
export function isGhost<T extends WithAtp<object>>(
  record: T,
): record is T & GhostEntry {
  return readSidecar(record)?.origin === 'ghost'
}

/**
 * Narrowed accessor: returns the ghost sidecar if this record is a
 * ghost, otherwise null. Saves one `as` cast at every call site that
 * wants to read ghost-specific fields.
 */
export function ghostSidecar<T extends WithAtp<object>>(
  record: T,
): AtpGhostSidecar | null {
  const s = readSidecar(record)
  return s?.origin === 'ghost' ? s : null
}

/**
 * Normalize a sidecar's `source` field to an array. Callers that need
 * to emit each original record don't have to branch on single-vs-array.
 */
export function sidecarSources<T>(source: T | T[]): T[] {
  return Array.isArray(source) ? source : [source]
}

/**
 * Return a shallow clone with `_atp` removed. Used by lossy mode to
 * emit smaller files that can't round-trip but render identically
 * in the target format's native parser.
 */
export function stripSidecar<T extends WithAtp<object>>(record: T): T {
  if (!(ATP_KEY in record)) return record
  const clone: Record<string, unknown> = { ...record }
  delete clone[ATP_KEY]
  return clone as T
}

// Clone a Codex rollout with a new session id.
//
// The on-disk Codex rollout format is a date-bucketed tree:
// `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`.
// The uuid in the filename MUST match `session_meta.payload.id` on
// the first line of the file. `codex resume <uuid>` finds the file
// by scanning the tree (with SQLite acceleration, self-repaired on
// a miss — see codex-rs `find_thread_path_by_id_str`), then reads
// the session_meta line to bootstrap.
//
// Duplicating a session therefore means:
//   1. Pick a new session uuid and a new timestamp.
//   2. Rewrite `session_meta.payload.id` (and `.timestamp`, so the
//      new rollout filename's embedded time doesn't collide with
//      the original on the same day-directory).
//   3. Leave every other `response_item` / `event_msg` /
//      `turn_context` / `compacted` line verbatim — none of them
//      carry the session id a second time.
//
// SQLite self-repair: codex-rs's resume path falls back to a fs
// scan when the state DB has no entry for the new uuid, and writes
// the discovered path back into the DB. So we don't touch SQLite
// directly — the duplicate is visible to `codex resume` immediately
// and the DB catches up on first resume.

import { randomUUID } from 'node:crypto'

import type { CodexRolloutLine } from './types.js'

export type CloneCodexOptions = {
  /** New session id. If omitted, a fresh UUID v4 is generated. */
  newSessionId?: string
  /** New `session_meta.timestamp` (ISO-8601). Defaults to now.
   *  Codex's writer reads this value to build the on-disk filename
   *  `rollout-<ts>-<uuid>.jsonl`, so bumping it ensures the clone
   *  lands alongside the source without filename collision. */
  newTimestamp?: string
}

export type CloneCodexResult = {
  lines: CodexRolloutLine[]
  newSessionId: string
  newTimestamp: string
}

export function cloneCodexRollout(
  source: readonly CodexRolloutLine[],
  options: CloneCodexOptions = {},
): CloneCodexResult {
  const newSessionId = options.newSessionId ?? randomUUID()
  const newTimestamp = options.newTimestamp ?? new Date().toISOString()

  let sawSessionMeta = false
  const lines: CodexRolloutLine[] = source.map(line => {
    if (line.type !== 'session_meta') {
      return line
    }
    sawSessionMeta = true
    // Clone payload and overwrite identity fields. Everything else
    // in the payload (cwd, originator, cli_version, git info, model
    // provider, memory_mode, etc.) is intentionally preserved —
    // those are context for the conversation, not per-session
    // uniqueness.
    const payload = { ...line.payload, id: newSessionId, timestamp: newTimestamp }
    return {
      ...line,
      timestamp: newTimestamp,
      payload,
    }
  })

  if (!sawSessionMeta) {
    throw new Error(
      'Codex rollout clone requires a session_meta line in the source.',
    )
  }

  return { lines, newSessionId, newTimestamp }
}

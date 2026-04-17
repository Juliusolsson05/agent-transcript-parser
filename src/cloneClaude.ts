// Clone a Claude transcript with a new session id.
//
// The on-disk Claude transcript format is a per-cwd directory with
// one file per session: `~/.claude/projects/<sanitized-cwd>/<uuid>.jsonl`.
// The uuid in the filename MUST match `entry.sessionId` on every
// entry inside — `claude --resume <uuid>` reads the file by that
// exact id.
//
// Duplicating a session therefore means:
//   1. Pick a new session uuid.
//   2. Rewrite `sessionId` on every entry to that new uuid.
//   3. (Optional) append a `(copy)` suffix to any `customTitle`
//      entry so the resume picker distinguishes the two.
//
// Per-entry `uuid` and `parentUuid` are file-local chain pointers —
// they don't need to be unique across files. Preserving them by
// default is cheapest and byte-preserves the conversation.
// Regenerating is exposed as an opt-in for callers that want the
// clone to have no overlap with the source at any level.

import { randomUUID } from 'node:crypto'

import type { ClaudeEntry } from './types.js'

export type CloneClaudeOptions = {
  /** New session id. If omitted, a fresh UUID v4 is generated. */
  newSessionId?: string
  /** Suffix appended to any `customTitle` entry encountered
   *  (default ` (copy)`). Pass `null` to preserve titles verbatim. */
  titleSuffix?: string | null
  /** Regenerate every entry's `uuid` — and rewrite the
   *  corresponding `parentUuid` chain pointers — so no per-entry
   *  id is shared with the source file. Default false; leaves the
   *  per-entry uuids untouched. Claude's resume flow does not
   *  cross-reference uuids across files, so collisions are safe. */
  regenerateEntryUuids?: boolean
}

export type CloneClaudeResult = {
  entries: ClaudeEntry[]
  newSessionId: string
}

const DEFAULT_TITLE_SUFFIX = ' (copy)'

export function cloneClaudeTranscript(
  source: readonly ClaudeEntry[],
  options: CloneClaudeOptions = {},
): CloneClaudeResult {
  const newSessionId = options.newSessionId ?? randomUUID()
  const titleSuffix = options.titleSuffix === null
    ? null
    : options.titleSuffix ?? DEFAULT_TITLE_SUFFIX

  const uuidMap: Map<string, string> | null = options.regenerateEntryUuids
    ? new Map()
    : null

  const entries: ClaudeEntry[] = source.map(entry => {
    const out: ClaudeEntry = { ...entry, sessionId: newSessionId }

    if (uuidMap) {
      // Walk produces fresh uuids on demand so parentUuid rewrites
      // can reference uuids we haven't yet emitted — important
      // because parentUuid chains can point forward in rare cases
      // (forked tool_use/tool_result ordering).
      const oldUuid = typeof entry.uuid === 'string' ? entry.uuid : null
      if (oldUuid) {
        let mapped = uuidMap.get(oldUuid)
        if (!mapped) {
          mapped = randomUUID()
          uuidMap.set(oldUuid, mapped)
        }
        out.uuid = mapped
      }
      const oldParent = entry.parentUuid
      if (typeof oldParent === 'string' && oldParent.length > 0) {
        let mapped = uuidMap.get(oldParent)
        if (!mapped) {
          mapped = randomUUID()
          uuidMap.set(oldParent, mapped)
        }
        out.parentUuid = mapped
      }
    }

    // customTitle lives on a dedicated entry type (`type: 'custom-title'`)
    // in Claude's transcript. Append the suffix once; skip if the
    // existing title already ends with the suffix so re-cloning a
    // clone doesn't produce `foo (copy) (copy)`.
    if (titleSuffix !== null && typeof entry.customTitle === 'string') {
      const title = entry.customTitle
      if (title.length > 0 && !title.endsWith(titleSuffix)) {
        out.customTitle = `${title}${titleSuffix}`
      }
    }

    return out
  })

  return { entries, newSessionId }
}

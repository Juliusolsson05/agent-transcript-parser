import type { ConversationDocument, ConversationEntry } from '../conversation/types.js'
import type { ProjectionChange, ProjectionChangeKind } from '../report/types.js'

export function archiveChange(
  entry: ConversationEntry,
  targetProvider: string,
  kind: ProjectionChangeKind,
  code: string,
  message: string,
): ProjectionChange {
  return {
    kind,
    sourceProvider: entry.source.provider,
    sourceLine: entry.source.line,
    targetProvider,
    code,
    message,
    evidence: entry.source.evidence,
  }
}

export function synthesizedArchiveChange(
  sourceProvider: string,
  targetProvider: string,
  code: string,
  message: string,
): ProjectionChange {
  return {
    kind: 'synthesized',
    sourceProvider,
    sourceLine: null,
    targetProvider,
    code,
    message,
    evidence: [],
  }
}

export function sameProviderSourceRecords(
  conversation: ConversationDocument,
  provider: string,
): ConversationEntry[] | null {
  if (conversation.sourceProvider !== provider) return null

  const seenLines = new Set<number>()
  const records: ConversationEntry[] = []
  for (const entry of conversation.entries) {
    if (entry.source.provider !== provider || seenLines.has(entry.source.line)) continue
    seenLines.add(entry.source.line)
    records.push(entry)
  }
  return records
}

export function cloneRawRecord(entry: ConversationEntry): Record<string, unknown> {
  // Source records entered the engine through JSON parsing, so JSON cloning is
  // the precise domain operation here. A generic object clone would imply that
  // functions, symbols, class instances, or cyclic objects are supported wire
  // values when none of those can exist in JSONL.
  return JSON.parse(JSON.stringify(entry.source.raw)) as Record<string, unknown>
}

export function archiveId(seed: string): string {
  // Archive ids need determinism and practical uniqueness, not cryptographic
  // identity. Four independently seeded FNV-1a lanes avoid Node crypto (the v2
  // core is browser-safe) while producing a UUID-shaped value accepted by
  // tooling that validates shape. Native-resume projection has a separate
  // identity contract and must not infer native safety from this helper.
  const hex = [0, 1, 2, 3]
    .map(lane => fnv1a32(`${lane}:${seed}`).toString(16).padStart(8, '0'))
    .join('')
    .split('')
  hex[12] = '5'
  const variant = Number.parseInt(hex[16] ?? '0', 16)
  hex[16] = ((variant & 0x3) | 0x8).toString(16)
  const value = hex.join('')
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

export function jsonText(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value) ?? 'null'
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fnv1a32(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

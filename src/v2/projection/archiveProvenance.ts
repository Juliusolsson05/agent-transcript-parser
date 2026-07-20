import { fingerprintJsonStructure } from '../evidence/fingerprint.js'
import type { ConversationEntry } from '../conversation/types.js'

const DEFAULT_MAX_EMBEDDED_SOURCE_BYTES = 64 * 1024

export function archiveProvenance(
  entry: ConversationEntry,
  maxBytes = DEFAULT_MAX_EMBEDDED_SOURCE_BYTES,
): Record<string, unknown> {
  const stripped = stripNestedProvenance(entry.source.raw)
  const serialized = JSON.stringify(stripped)
  return {
    schema_version: 1,
    source_provider: entry.source.provider,
    source_line: entry.source.line,
    source_fingerprint: fingerprintJsonStructure(stripped).fingerprint,
    // WHY complete source is conditional: v1 recursively embedded source
    // objects and relied on perfect short-circuiting to avoid growth. Archive
    // fidelity still benefits from carrying small unknown records, but a size
    // cap plus recursive-provenance removal makes repeated switches bounded.
    ...(serialized.length <= maxBytes
      ? { source: stripped }
      : { source_omitted: true, source_bytes: serialized.length }),
  }
}

function stripNestedProvenance(value: unknown, depth = 0): unknown {
  if (depth > 32) return '<depth-limit>'
  if (Array.isArray(value)) return value.map(item => stripNestedProvenance(item, depth + 1))
  if (!isRecord(value)) return value
  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (key === '_atp' || key === '_atp_v2' || key === 'atp_archive') continue
    result[key] = stripNestedProvenance(child, depth + 1)
  }
  return result
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

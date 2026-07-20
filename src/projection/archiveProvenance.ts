import { fingerprintJsonStructure } from '../evidence/fingerprint.js'
import type { ConversationEntry } from '../conversation/types.js'

const DEFAULT_MAX_EMBEDDED_SOURCE_BYTES = 64 * 1024

export function archiveProvenance(
  entry: ConversationEntry,
  maxBytes = DEFAULT_MAX_EMBEDDED_SOURCE_BYTES,
): Record<string, unknown> {
  const prior = existingArchiveProvenance(entry.source.raw)
  if (prior && prior.source_omitted === true && !isRecord(prior.source)) {
    // WHY an already-capped archive remains capped instead of embedding its
    // carrier record: the carrier is transport, not new source evidence.
    // Re-wrapping it would restart growth after the fidelity cap fired.
    return {
      schema_version: 1,
      source_provider: stringField(prior, 'source_provider') ?? entry.source.provider,
      source_line: numberField(prior, 'source_line') ?? entry.source.line,
      source_fingerprint: stringField(prior, 'source_fingerprint') ?? fingerprintJsonStructure({}).fingerprint,
      source_omitted: true,
      ...(typeof prior.source_bytes === 'number' ? { source_bytes: prior.source_bytes } : {}),
    }
  }
  const stripped = stripNestedProvenance(isRecord(prior?.source) ? prior.source : entry.source.raw)
  const serialized = JSON.stringify(stripped)
  const sourceBytes = new TextEncoder().encode(serialized).byteLength
  return {
    schema_version: 1,
    source_provider: prior ? stringField(prior, 'source_provider') ?? entry.source.provider : entry.source.provider,
    source_line: prior ? numberField(prior, 'source_line') ?? entry.source.line : entry.source.line,
    source_fingerprint: fingerprintJsonStructure(stripped).fingerprint,
    // WHY complete source is conditional: the displaced pairwise converter
    // recursively embedded source objects and relied on perfect short-circuiting
    // to avoid growth. Archive
    // fidelity still benefits from carrying small unknown records, but a size
    // cap plus recursive-provenance removal makes repeated switches bounded.
    ...(sourceBytes <= maxBytes
      ? { source: stripped }
      : { source_omitted: true, source_bytes: sourceBytes }),
  }
}

function existingArchiveProvenance(raw: Record<string, unknown>): Record<string, unknown> | null {
  // WHY all three placements are recognized: native provider records carry
  // provenance in `atp_archive`, opaque archive carriers put it directly in
  // `payload`, and non-native Claude messages put it in
  // `payload.provenance`. They are the same envelope at different wire seams;
  // missing one causes provenance depth to grow on every provider hop.
  if (isRecord(raw.atp_archive) && isArchiveProvenance(raw.atp_archive)) return raw.atp_archive
  if (raw.type !== 'atp_archive' || !isRecord(raw.payload)) return null
  if (isArchiveProvenance(raw.payload)) return raw.payload
  const provenance = raw.payload.provenance
  return isRecord(provenance) && isArchiveProvenance(provenance) ? provenance : null
}

function isArchiveProvenance(value: Record<string, unknown>): boolean {
  return value.schema_version === 1 && typeof value.source_provider === 'string'
}

function stripNestedProvenance(value: unknown, depth = 0): unknown {
  if (depth > 32) return '<depth-limit>'
  if (Array.isArray(value)) return value.map(item => stripNestedProvenance(item, depth + 1))
  if (!isRecord(value)) return value
  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (key === '_atp' || key === 'atp_archive') continue
    result[key] = stripNestedProvenance(child, depth + 1)
  }
  return result
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  return typeof record[key] === 'string' ? record[key] as string : null
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  return typeof record[key] === 'number' && Number.isFinite(record[key]) ? record[key] as number : null
}

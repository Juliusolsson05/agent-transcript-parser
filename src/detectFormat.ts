// Format auto-detection for callers that don't know what they're
// holding. Looks at the first record's shape and discriminates.

export function detectFormat(
  input: readonly unknown[],
): 'claude' | 'codex' | 'unknown' {
  if (input.length === 0) return 'unknown'
  const first = input[0] as Record<string, unknown> | null
  if (!first || typeof first !== 'object') return 'unknown'

  // Codex: every line has { timestamp, type, payload } with payload
  // an object. The 'type' is a small enumeration.
  if (
    'payload' in first &&
    typeof first.payload === 'object' &&
    first.payload !== null &&
    'type' in first &&
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

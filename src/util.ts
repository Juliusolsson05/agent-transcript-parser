// Small pure helpers used by toClaude and toCodex.
// No transcript-shape knowledge here — that lives in the mappers.
// These are generic enough to be testable in isolation.

import { createHash } from 'node:crypto'

/**
 * Deterministic uuid-shaped string from a stable set of inputs.
 *
 * Used when a Codex record has no Claude-compatible uuid — we derive
 * one from (sessionId, record index, line timestamp, payload kind) so
 * repeat conversions of the same transcript produce identical uuids.
 * This is important for the renderer's memoization keys: a re-parse
 * of the same file must produce the same uuid or cached rows get
 * invalidated.
 *
 * Not a strictly-valid RFC4122 uuid (we don't set version/variant
 * bits). Claude's own tooling only treats uuids as opaque strings,
 * so the 8-4-4-4-12 layout is all that matters.
 */
export function stableUuid(inputs: Array<string | number>): string {
  const hash = createHash('sha256').update(inputs.join('|')).digest('hex')
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join('-')
}

/**
 * Codex stores `function_call.arguments` as a JSON-encoded string
 * (OpenAI Responses API convention). Parse to an object so the
 * resulting Claude tool_use block has a proper structured `input`.
 *
 * Fallback when parsing fails: `{ arguments: raw }`. This ensures the
 * entry still renders (the raw string is visible in a field) rather
 * than dropping the whole tool call because of malformed JSON.
 */
export function parseToolInput(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return { arguments: raw }
  }
}

/**
 * Normalize a Codex function-call output payload into a plain-text
 * string plus extracted metadata.
 *
 *   - string output → { text, metadata: undefined }
 *   - custom_tool_call_output (JSON-wrapped: `{output, metadata}`) →
 *     unwrap; text = parsed.output, metadata = parsed.metadata
 *   - array output with text blocks → concatenate texts; last
 *     metadata object wins
 *
 * The text goes into Claude's `tool_result.content` string; the
 * metadata goes into the block's `codex` field so round-trip can
 * reconstruct the original shape.
 */
export function normalizeOutput(
  raw: unknown,
): {
  text: string
  metadata?: Record<string, unknown>
  richContent?: Array<{ type: string; text?: string; [k: string]: unknown }>
} {
  if (typeof raw === 'string') {
    // custom_tool_call_output often wraps JSON in the string — detect
    // and unwrap. Plain-string outputs (function_call_output) pass
    // through unchanged.
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
        // Not JSON-wrapped — fall through to plain-string handling.
      }
    }
    return { text: raw }
  }
  if (Array.isArray(raw)) {
    const parts: string[] = []
    const richContent: Array<{ type: string; text?: string; [k: string]: unknown }> = []
    let metadata: Record<string, unknown> | undefined
    for (const item of raw as Array<Record<string, unknown>>) {
      if (typeof item.text === 'string') parts.push(item.text)
      if (item.metadata && typeof item.metadata === 'object') {
        metadata = item.metadata as Record<string, unknown>
      }
      // Claude accepts richer tool_result.content arrays than a plain
      // string: text, image, document, and search_result. Preserving
      // those here lets Codex structured tool outputs survive as native
      // Claude tool results instead of being flattened to lossy text.
      //
      // We keep this intentionally conservative: only pass through the
      // small set of block types Claude explicitly handles. Unknown
      // content item types still contribute their text to the fallback
      // string but are not copied structurally, because inventing a
      // Claude block type here would create transcripts that resume but
      // later fail validation on the next API call.
      if (typeof item.type === 'string') {
        if (item.type === 'text' && typeof item.text === 'string') {
          richContent.push({ type: 'text', text: item.text })
        } else if (
          item.type === 'image' ||
          item.type === 'document' ||
          item.type === 'search_result'
        ) {
          richContent.push(item as { type: string; text?: string; [k: string]: unknown })
        }
      }
    }
    return {
      text: parts.join('\n'),
      metadata,
      ...(richContent.length > 0 ? { richContent } : {}),
    }
  }
  return { text: '' }
}

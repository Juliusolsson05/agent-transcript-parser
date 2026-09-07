import { readFile } from 'node:fs/promises'

import { classifyClaudeDocument } from '../../src/claude/classify/index.js'
import { decodeClaudeConversation } from '../../src/claude/conversation/index.js'
import { classifyCodexDocument } from '../../src/codex/classify/index.js'
import { decodeCodexConversation } from '../../src/codex/conversation/index.js'
import type { ConversationDocument, ConversationEntry } from '../../src/conversation/types.js'
import { decodeJsonl } from '../../src/jsonl/codec.js'

// Shared loaders for the Stage 0 observed-sequence fixtures. Three suites now
// decode the same six files (shrink, contextBudget, nativeResumeProjection);
// keeping one copy means a decoder change breaks all three at once instead of
// leaving a stale private copy behind in whichever file was not touched.

const sequences = new URL('../../fixtures/evidence/observed-sequences/', import.meta.url)

export async function codex(caseId: string): Promise<ConversationDocument> {
  const raw = decodeJsonl(await readFile(new URL(`${caseId}/source.jsonl`, sequences), 'utf8'))
  return decodeCodexConversation(classifyCodexDocument(raw).records)
}

export async function claude(caseId: string): Promise<ConversationDocument> {
  const raw = decodeJsonl(await readFile(new URL(`${caseId}/source.jsonl`, sequences), 'utf8'))
  return decodeClaudeConversation(classifyClaudeDocument(raw).records)
}

/**
 * Census-measured mean payload sizes, in characters, for the entry kinds the
 * shrink ladder acts on.
 *
 * WHY this table exists at all — read this before deleting it as a test-only
 * fabrication. `docs/decomposition/evidence/provider-switch/census.md` caveat 1
 * is explicit: the committed fixtures prove *shape*, not *size*. Redaction
 * replaces every private scalar with `"fixture text"`, which collapses the
 * fixtures to 0.3–2.4 % of the real byte totals. Measured on the committed
 * files, the largest single tool-result output in ANY of the six fixtures is
 * **51 characters** and the largest serialized tool-call input is **153**.
 *
 * The two size-driven rungs cannot be reached at that scale by construction,
 * not by accident:
 *
 * - `clearToolResults` replaces an output with
 *   `[tool output cleared during provider switch: N characters]` — 55+
 *   characters. The ladder refuses to clear an output that the placeholder
 *   would make *longer*, so on the committed bytes it correctly clears nothing.
 * - `trimToolInputs` writes a similar marker, so trimming a 153-character input
 *   also cannot save anything.
 *
 * Census caveat 1 names the remedy: "Any Stage 2 assertion about *characters*
 * must use the numbers in this document or a conversation built in the test."
 * This helper is the second option applied to the first: it keeps the fixture's
 * real structure — 1,470 entries, 110 user turns, one genuine portable Claude
 * carrier, the real interleaving of calls and results — and restores the census
 * table's measured mean payload sizes on top of it. Nothing but tool payload
 * *lengths* changes; kinds, order, ids, roles and timestamps are the fixture's.
 *
 * The numbers below are `Real bytes ÷ Entries` from the census's
 * `claude-sequence-oversized-turns` table (§"The two majority-shape fixtures").
 */
export const CENSUS_OVERSIZED_TURNS_PAYLOADS = {
  /** 733,557 real characters across 364 tool-result entries. */
  resultChars: 2_015,
  /** 869,924 real characters across 364 tool-call entries (Write/Edit payloads). */
  inputChars: 2_390,
} as const

/**
 * Restore census-measured payload sizes onto a redacted fixture conversation.
 *
 * Only `tool-result.output` and the largest string-valued member of
 * `tool-call.input` are resized. Message text is deliberately left redacted:
 * the drop rung indexes user prompts into its marker, and inflating prompts
 * would make that index assert against filler instead of the fixture's own
 * (already faithful) turn structure.
 */
export function withCensusToolPayloads(
  conversation: ConversationDocument,
  sizes: { resultChars: number; inputChars: number },
): ConversationDocument {
  const entries = conversation.entries.map((entry): ConversationEntry => {
    if (entry.kind === 'tool-result') {
      return { ...entry, output: filler(sizes.resultChars) }
    }
    if (entry.kind === 'tool-call') {
      return { ...entry, input: inflateInput(entry.input, sizes.inputChars) }
    }
    return entry
  })
  return { ...conversation, entries }
}

function inflateInput(input: unknown, chars: number): unknown {
  if (typeof input === 'string') return filler(chars)
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input
  const record = { ...(input as Record<string, unknown>) }
  // Grow the property that already holds the most text. On a real Claude
  // `Write` this is `content`; `file_path` and the other short scalars stay
  // untouched, which is exactly the shape the trim rung must preserve.
  const widest = Object.keys(record)
    .filter(key => typeof record[key] === 'string')
    .sort((a, b) => (record[b] as string).length - (record[a] as string).length)[0]
  if (widest === undefined) return record
  record[widest] = filler(chars)
  return record
}

function filler(chars: number): string {
  const unit = 'census-scaled payload. '
  return unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars)
}

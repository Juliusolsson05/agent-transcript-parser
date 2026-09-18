import { readFile } from 'node:fs/promises'

import { classifyClaudeDocument } from '../../src/claude/classify/index.js'
import { decodeClaudeConversation } from '../../src/claude/conversation/index.js'
import { classifyCodexDocument } from '../../src/codex/classify/index.js'
import { decodeCodexConversation } from '../../src/codex/conversation/index.js'
import type {
  ConversationContent,
  ConversationDocument,
  ConversationEntry,
  ConversationMessage,
} from '../../src/conversation/types.js'
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

// ---------------------------------------------------------------------------
// Hand-built neutral entries, for assertions about CHARACTERS.
// ---------------------------------------------------------------------------
//
// WHY these live next to the fixture loaders above instead of inside one test
// file: census caveat 1 says the committed fixtures prove shape, not size, so
// any test that needs a payload of a controlled length — a tool output the
// clearing rung can act on, an image that dominates its turn — has to build
// the conversation itself. The planner suite and the ladder suite both need
// that: the planner suite had a private copy of these builders and the ladder
// suite hand-built the same three entry shapes inline, so both now build from
// here. Every builder takes the entry's `line` so a
// test can still reason about source coordinates.

export function source(
  line: number,
  raw: Record<string, unknown> = {},
): Pick<ConversationEntry, 'timestamp' | 'source'> {
  return {
    timestamp: '2026-07-21T00:00:00.000Z',
    source: { provider: 'fixture', line, raw, evidence: [] },
  }
}

export function message(
  role: ConversationMessage['role'],
  content: string | ConversationContent[],
  line: number,
): ConversationEntry {
  return {
    kind: 'message',
    role,
    content: typeof content === 'string' ? [{ kind: 'text', text: content }] : content,
    ...source(line),
  }
}

export function toolCall(
  line: number,
  callId = 'call-1',
  input: unknown = { path: '/tmp/file' },
): ConversationEntry {
  return {
    kind: 'tool-call',
    callId,
    name: 'Read',
    input,
    nativeKind: 'fixture',
    ...source(line),
  }
}

export function toolResult(
  line: number,
  callId = 'call-1',
  output: unknown = 'contents',
): ConversationEntry {
  return {
    kind: 'tool-result',
    callId,
    output,
    isError: false,
    nativeKind: 'fixture',
    ...source(line),
  }
}

/**
 * A base64 image content item whose payload is `chars` characters long, in the
 * observed Claude block shape (`claude-message-block-image`). The estimator
 * charges the whole serialized value, so `chars` is also roughly what the item
 * costs the budget.
 */
export function image(chars: number): ConversationContent {
  return {
    kind: 'image',
    value: {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(chars) },
    },
  }
}

export function conversationOf(
  entries: ConversationEntry[],
  sourceProvider = 'fixture',
): ConversationDocument {
  return { schemaVersion: 1, sourceProvider, sourceSessionIds: ['source'], entries }
}

/**
 * The shape behind agent-transcript-parser#28, scaled down.
 *
 * The real transcript (recorded 2026-09-18, 1,100 entries, 16 safe boundaries)
 * ended with two user turns that no rung could touch: a 129-character prompt
 * carrying a 713,997-character `opaque` block — an OpenCode `file` part that an
 * earlier OpenCode → Claude switch had copied into the Claude file — and then
 * a 15-character prompt carrying a 549,526-character base64 screenshot,
 * followed only by zero-cost opaque records (attachments, an `api_error`). Every
 * earlier turn was an ordinary tool cycle. Against a 288,000-character budget
 * the ladder cleared 256 outputs, trimmed 3 inputs, dropped 15 turns and still
 * threw, because the newest turn was 99.98 % one image.
 *
 * Sizes here are 1/20th to 1/25th of the real ones so a budget of a few
 * thousand characters reproduces the same arithmetic: the tool cycles alone
 * would fit after clearing, and each of the two attachments alone exceeds the
 * budget. Assistant replies are padded so that clearing every payload is still
 * not enough and the drop rung has to fire as well — which is the real
 * transcript's proportion, not an embellishment.
 */
export function pastedImageTailConversation(): ConversationDocument {
  const entries: ConversationEntry[] = []
  const line = (): number => entries.length
  for (let turn = 0; turn < 5; turn += 1) {
    entries.push(message('user', `prompt ${turn}`, line()))
    entries.push(toolCall(line(), `call-${turn}`, { command: `ls -la /fixture/${turn}` }))
    entries.push(toolResult(line(), `call-${turn}`, 'directory listing '.repeat(120)))
    entries.push(message('assistant', `done with ${turn}. `.repeat(50), line()))
  }
  entries.push(message('user', [
    { kind: 'text', text: 'can you figure out why the padding is off in the attached screenshot' },
    {
      kind: 'opaque',
      nativeType: 'file',
      value: {
        type: 'file',
        mime: 'image/png',
        filename: 'clipboard',
        url: `data:image/png;base64,${'B'.repeat(20_000)}`,
      },
    },
  ], line()))
  entries.push(message('assistant', "Two things up front: I can't view images in this session.", line()))
  entries.push(message('user', [{ kind: 'text', text: 'This [Image #1]' }, image(30_000)], line()))
  entries.push({ kind: 'opaque', nativeType: 'attachment', ...source(line()) })
  entries.push({ kind: 'opaque', nativeType: 'api_error', ...source(line()) })
  return conversationOf(entries, 'claude')
}

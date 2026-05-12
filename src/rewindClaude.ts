// Rewind a Claude transcript to "just before" a selected user prompt.
//
// Produces a new transcript that retains every entry strictly BEFORE
// the anchored user prompt and drops the anchor plus everything that
// came after. The returned transcript carries a fresh sessionId so
// writing it to disk does not overwrite the source file — `claude
// --resume <newSessionId>` reads the new file as an independent
// conversation whose history ends at the chosen point.
//
// The caller supplies the anchor as the Claude-native user entry
// `uuid`. The prompt text is intentionally NOT written into the
// truncated transcript — Agent Code hands it back to the renderer as a
// `draftInput` so the user can edit/re-send or just rewrite from
// scratch. The feature is "continue from here with an unsent draft",
// not "replay this prompt automatically".
//
// WHY a dedicated entry-point instead of reusing cloneClaudeTranscript:
//
//   1. Cloning preserves the full history; rewind needs the prefix
//      up to (but excluding) the anchor. Wiring a "drop tail" mode
//      into the clone file blurs the contract of that file ("produce
//      an independent duplicate") into two unrelated jobs.
//   2. Rewind has to handle orphan tool_use pairing: the anchor may
//      split an assistant's tool_use from its paired tool_result,
//      and Claude's resume loader rejects transcripts with a dangling
//      tool_use_id (see claude-code-src/utils/sessionStorage.ts —
//      recoverOrphanedParallelToolResults handles READ, but WRITE-time
//      rejection is stricter). Cloning never introduces orphans
//      because it never drops anything, so that logic belongs here.
//   3. The compact-boundary + isCompactSummary pair is meaningful
//      only when BOTH entries survive the truncation. Rewind must
//      detect and drop a lone compact_boundary whose summary fell on
//      the dropped side; cloning never splits pairs.
//
// This file owns the transcript-shape rules. Filesystem IO and
// session-file naming live in `src/main/providerSwitch/rewindSession.ts`
// in Agent Code so the parser package stays browser-buildable and
// free of Node fs imports, matching the layering of `cloneClaude.ts`.

import { randomUUID } from 'node:crypto'

import type { ClaudeContentBlock, ClaudeEntry } from './types.js'

export type RewindClaudeAnchor = {
  /** The uuid of the user-role entry we are rewinding to. Everything
   *  with index >= the anchor's position is dropped. */
  uuid: string
}

export type RewindClaudeOptions = {
  /** New session id. If omitted a fresh UUID v4 is generated. The
   *  returned transcript's `sessionId` is stamped onto every retained
   *  entry so Claude's resume loader binds the file correctly. */
  newSessionId?: string
  /** Optional suffix appended to a `customTitle` entry so the resume
   *  picker distinguishes the rewound session from the source.
   *  Defaults to ` (rewound)`; pass `null` to preserve titles
   *  verbatim. */
  titleSuffix?: string | null
}

/** An image block recovered from the anchored user entry. Base64 data
 *  is returned verbatim (same shape as Anthropic's `image` block
 *  source) so the renderer can round-trip it back into a composer
 *  draft without re-encoding. */
export type RewindClaudeImageBlock = {
  mediaType: string
  data: string
}

export type RewindClaudeResult = {
  entries: ClaudeEntry[]
  newSessionId: string
  /** The prompt text for the anchored user entry, extracted from the
   *  source transcript so the caller can prefill it as a draft.
   *
   *  Extraction mirrors claude-code-src/utils/messages.ts
   *  `textForResubmit`:
   *    1. If the text contains a `<bash-input>` tag, the unwrapped
   *       body is returned as-is (renderer prefills bash mode, which
   *       for Agent Code means prefixing `!` on the draft).
   *    2. If it contains a `<command-name>` tag, the return shape is
   *       `<cmd> <args>` so the renderer can populate a slash-command
   *       invocation.
   *    3. Otherwise IDE-context wrapper tags (`<ide_selection>`,
   *       `<system-reminder>`) are stripped and the remaining text
   *       is returned.
   *
   *  The returned text is NOT present inside `entries`; the truncated
   *  transcript ends BEFORE the anchor. */
  promptText: string
  /** The `mode` Claude Code's composer would use for the prefill. See
   *  claude-code-src/utils/messages.ts — `'bash'` when the anchor was
   *  a bash-input prompt, otherwise `'prompt'`. Agent Code's composer
   *  does not have a discrete bash mode today, but exposing the hint
   *  lets the caller prefix `!` (or open a bash submode) if desired. */
  promptMode: 'prompt' | 'bash'
  /** Image blocks pulled from the anchored user entry. Order matches
   *  the anchor's content-block order. Empty when the anchor had no
   *  image blocks. */
  promptImages: RewindClaudeImageBlock[]
  /** Position of the anchor in the source transcript. Useful for
   *  debug surfaces; the caller normally does not need to consume
   *  this. */
  anchorIndex: number
}

const DEFAULT_TITLE_SUFFIX = ' (rewound)'

export class RewindClaudeAnchorNotFoundError extends Error {
  constructor(anchor: RewindClaudeAnchor) {
    super(
      `Claude rewind anchor ${JSON.stringify(anchor)} did not match a user entry in the transcript.`,
    )
    this.name = 'RewindClaudeAnchorNotFoundError'
  }
}

export function rewindClaudeTranscript(
  source: readonly ClaudeEntry[],
  anchor: RewindClaudeAnchor,
  options: RewindClaudeOptions = {},
): RewindClaudeResult {
  const newSessionId = options.newSessionId ?? randomUUID()
  const titleSuffix = options.titleSuffix === null
    ? null
    : options.titleSuffix ?? DEFAULT_TITLE_SUFFIX

  // ---------------------------------------------------------------------
  // Locate the anchor.
  //
  // We require an EXACT uuid match on a user-role entry. Matching on
  // anything else (type='assistant', type='system', the uuid of an
  // attachment row) would corrupt the truncation: the retained slice
  // could include half of an assistant's response or a tool_use whose
  // tool_result we just dropped.
  //
  // We also tolerate user entries WITHOUT `message` — the anchor is
  // still a legitimate boundary even if the entry is a tool_result-only
  // user row. That case is rare in practice (pickers filter those out)
  // but cheap to accept here.
  // ---------------------------------------------------------------------
  const anchorIndex = source.findIndex(entry => {
    if (entry.type !== 'user') return false
    if (typeof entry.uuid !== 'string') return false
    return entry.uuid === anchor.uuid
  })
  if (anchorIndex < 0) {
    throw new RewindClaudeAnchorNotFoundError(anchor)
  }

  const prompt = extractAnchorPrompt(source[anchorIndex])

  // ---------------------------------------------------------------------
  // Slice out everything strictly before the anchor.
  //
  // This is the load-bearing truncation. Every other rule in this
  // function operates on `retained` and cannot re-introduce entries
  // from `dropped`.
  // ---------------------------------------------------------------------
  const retained = source.slice(0, anchorIndex)

  // ---------------------------------------------------------------------
  // Orphan tool_use detection.
  //
  // Claude's API rejects a message chain where an assistant turn
  // contains a `tool_use` block whose `tool_use_id` has no matching
  // `tool_result` block in a later user-role entry. That's the shape
  // we could easily produce when the anchor lands between an
  // assistant's tool_use and its tool_result in the next user turn.
  //
  // Strategy:
  //   1. Collect every `tool_result.tool_use_id` present in the
  //      retained slice.
  //   2. Walk retained entries. For every assistant entry with
  //      block-form content, strip any `tool_use` block whose id is
  //      not in the resolved set.
  //   3. If stripping empties the content array, drop the assistant
  //      entry entirely.
  //
  // We only strip from ASSISTANT entries because tool_result blocks
  // only ever ride on user-role entries. Text/thinking blocks on the
  // assistant are preserved verbatim — they carry the model's final
  // answer and have no external pairing requirement.
  // ---------------------------------------------------------------------
  const resolvedToolUseIds = new Set<string>()
  for (const entry of retained) {
    if (entry.type !== 'user') continue
    const content = entry.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!isToolResultBlock(block)) continue
      const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : null
      if (id) resolvedToolUseIds.add(id)
    }
  }

  // ---------------------------------------------------------------------
  // Compact-boundary pair detection.
  //
  // Claude writes compaction as two adjacent entries:
  //   - `system { subtype: 'compact_boundary' }`
  //   - `user  { isCompactSummary: true }`
  //
  // The summary carries the actual context hand-off text; the
  // boundary is just a marker. Keeping the boundary without its
  // summary is meaningless at best and actively confuses the
  // post-compact resume path at worst. Detection is local: a
  // boundary's summary is always the very next conversation-bearing
  // entry. We only drop lone boundaries when the summary is NOT in
  // the retained slice.
  // ---------------------------------------------------------------------
  const retainedIndexOfSummaryBySourceIndex = new Map<number, number>()
  for (let i = 0; i < retained.length; i++) {
    const entry = retained[i]
    if (entry?.type === 'user' && entry.isCompactSummary === true) {
      retainedIndexOfSummaryBySourceIndex.set(i, i)
    }
  }

  // ---------------------------------------------------------------------
  // Walk the retained slice and produce the final entry list.
  // ---------------------------------------------------------------------
  const entries: ClaudeEntry[] = []
  for (let i = 0; i < retained.length; i++) {
    const entry = retained[i]!

    // Lone compact_boundary — summary lived at >= anchor and was
    // dropped, so the boundary is useless. Skip it.
    if (
      entry.type === 'system' &&
      entry.subtype === 'compact_boundary' &&
      !hasAdjacentCompactSummary(retained, i)
    ) {
      continue
    }

    // Assistant entries: strip orphan tool_use blocks. If stripping
    // empties the content array, skip the entry entirely.
    if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
      const cleaned = filterOrphanToolUses(
        entry.message!.content as ClaudeContentBlock[],
        resolvedToolUseIds,
      )
      if (cleaned === null) {
        continue
      }
      entries.push(stampSessionId(applyTitleSuffix(withContent(entry, cleaned), titleSuffix), newSessionId))
      continue
    }

    // Default path: retain the entry, only rewrite sessionId + title.
    entries.push(stampSessionId(applyTitleSuffix(entry, titleSuffix), newSessionId))
  }

  return {
    entries,
    newSessionId,
    promptText: prompt.text,
    promptMode: prompt.mode,
    promptImages: prompt.images,
    anchorIndex,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stampSessionId(entry: ClaudeEntry, newSessionId: string): ClaudeEntry {
  if (entry.sessionId === newSessionId) return entry
  return { ...entry, sessionId: newSessionId }
}

function applyTitleSuffix(
  entry: ClaudeEntry,
  suffix: string | null,
): ClaudeEntry {
  if (suffix === null) return entry
  if (typeof entry.customTitle !== 'string') return entry
  const title = entry.customTitle
  if (title.length === 0) return entry
  if (title.endsWith(suffix)) return entry
  return { ...entry, customTitle: `${title}${suffix}` }
}

function withContent(
  entry: ClaudeEntry,
  content: ClaudeContentBlock[],
): ClaudeEntry {
  if (!entry.message) return entry
  return {
    ...entry,
    message: {
      ...entry.message,
      content,
    },
  }
}

function filterOrphanToolUses(
  content: ClaudeContentBlock[],
  resolvedToolUseIds: Set<string>,
): ClaudeContentBlock[] | null {
  let mutated = false
  const kept: ClaudeContentBlock[] = []
  for (const block of content) {
    if (isToolUseBlock(block)) {
      const id = typeof block.id === 'string' ? block.id : null
      if (id && resolvedToolUseIds.has(id)) {
        kept.push(block)
      } else {
        mutated = true
      }
      continue
    }
    kept.push(block)
  }
  if (!mutated) return content
  if (kept.length === 0) return null
  return kept
}

function isToolUseBlock(
  block: ClaudeContentBlock,
): block is ClaudeContentBlock & { type: 'tool_use'; id?: string } {
  return (block as { type?: string }).type === 'tool_use'
}

function isToolResultBlock(
  block: ClaudeContentBlock,
): block is ClaudeContentBlock & { type: 'tool_result'; tool_use_id?: string } {
  return (block as { type?: string }).type === 'tool_result'
}

function hasAdjacentCompactSummary(
  retained: readonly ClaudeEntry[],
  boundaryIndex: number,
): boolean {
  // The summary can be up to a few entries away from the boundary in
  // some legacy transcripts (file-history-snapshot noise slips between
  // them), so we scan forward a small window rather than only checking
  // the immediate next index.
  const WINDOW = 4
  for (let i = boundaryIndex + 1; i < retained.length && i <= boundaryIndex + WINDOW; i++) {
    const entry = retained[i]
    if (entry?.type === 'user' && entry.isCompactSummary === true) return true
  }
  return false
}

type AnchorPrompt = {
  text: string
  mode: 'prompt' | 'bash'
  images: RewindClaudeImageBlock[]
}

/**
 * Mirror claude-code-src/utils/messages.ts `textForResubmit` plus
 * image recovery.
 *
 * Order:
 *   1. Gather every `text` block's text, separated by newlines.
 *   2. If the combined string contains a `<bash-input>...</bash-input>`
 *      tag, return the tag body with mode='bash'.
 *   3. Else if it contains a `<command-name>...</command-name>` tag,
 *      return `<name> <args>` (args may be empty) with mode='prompt'.
 *   4. Else strip IDE-context wrapper tags and return the remainder
 *      with mode='prompt'.
 *
 * Image blocks are collected in document order regardless of the
 * text path taken so a prompt with `<bash-input>` AND a pasted image
 * round-trips both the text and the image.
 */
function extractAnchorPrompt(entry: ClaudeEntry | undefined): AnchorPrompt {
  if (!entry || entry.type !== 'user') {
    return { text: '', mode: 'prompt', images: [] }
  }
  const content = entry.message?.content
  if (typeof content === 'string') {
    return unwrapPromptText(content)
  }
  if (!Array.isArray(content)) {
    return { text: '', mode: 'prompt', images: [] }
  }

  const textParts: string[] = []
  const images: RewindClaudeImageBlock[] = []
  for (const block of content) {
    const type = (block as { type?: string }).type
    if (type === 'text') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string') textParts.push(text)
      continue
    }
    if (type === 'image') {
      const source = (block as { source?: unknown }).source
      if (source && typeof source === 'object') {
        const rec = source as Record<string, unknown>
        if (rec.type === 'base64') {
          const mediaType =
            typeof rec.media_type === 'string' ? rec.media_type : 'image/png'
          const data = typeof rec.data === 'string' ? rec.data : null
          if (data) images.push({ mediaType, data })
        }
      }
    }
  }

  const joined = textParts.join('\n')
  const prompt = unwrapPromptText(joined)
  return { ...prompt, images }
}

function unwrapPromptText(text: string): AnchorPrompt {
  const bash = extractTagBody(text, 'bash-input')
  if (bash !== null) {
    return { text: bash, mode: 'bash', images: [] }
  }
  const cmd = extractTagBody(text, 'command-name')
  if (cmd !== null) {
    const args = extractTagBody(text, 'command-args') ?? ''
    const joined = args.length > 0 ? `${cmd} ${args}` : cmd
    return { text: joined, mode: 'prompt', images: [] }
  }
  return { text: stripIdeContextTags(text), mode: 'prompt', images: [] }
}

/**
 * Extract the inner text of the first `<tag>...</tag>` occurrence.
 * Returns null when the tag isn't present. Intentionally simple
 * (regex, not an HTML parser) because Claude's wire format for these
 * envelopes is stable and always a single well-formed tag per entry.
 */
function extractTagBody(source: string, tag: string): string | null {
  // `[\s\S]` matches newlines too; CC's envelope bodies frequently
  // include line breaks (slash-command outputs, multi-line args).
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)
  const match = source.match(re)
  if (!match) return null
  return (match[1] ?? '').trim()
}

/**
 * Remove IDE-context wrappers that CC injects into a user message.
 * Matches stripIdeContextTags in claude-code-src/utils/displayTags.ts
 * — the list here is deliberately conservative. Tags we know are
 * user-invisible envelopes are stripped entirely (open + close); any
 * others are left alone so we don't accidentally wipe legitimate
 * angle-bracket content the user typed.
 */
function stripIdeContextTags(source: string): string {
  const wrappers = [
    'ide_selection',
    'ide_diagnostics',
    'ide_opened_files',
    'local-command-caveat',
    'local-command-stdout',
    'system-reminder',
  ]
  let out = source
  for (const tag of wrappers) {
    const re = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g')
    out = out.replace(re, '')
  }
  return out.trim()
}

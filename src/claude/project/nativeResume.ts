import type {
  ConversationContent,
  ConversationDocument,
  ConversationEntry,
  ConversationMessage,
  ConversationToolCall,
  ConversationToolResult,
} from '../../conversation/types.js'
import type { EvidenceClaim } from '../../evidence/claim.js'
import { archiveId, isRecord } from '../../projection/archiveHelpers.js'
import { nativeResumeChange } from '../../projection/nativeResumeHelpers.js'
import type {
  NativeResumeProfile,
  NativeResumeProjectionResult,
  NativeResumeProjector,
  ProjectionBaseOptions,
} from '../../projection/types.js'
import { pairConversationTools } from '../../projection/toolPairs.js'
import { createProjectionReport, type ProjectionChange } from '../../report/types.js'

const TARGET = 'claude' as const
const CLAUDE_NATIVE_EVIDENCE: EvidenceClaim = {
  provenance: 'observed-wire',
  rule: 'claude-native-resume-projection',
  profile: { provider: TARGET },
}

export interface ClaudeNativeResumeOptions extends ProjectionBaseOptions {
  cwd: string
  version: string
  model: string
  gitBranch?: string
  entrypoint?: string
  idFactory?: (seed: string) => string
}

export const claudeNativeResumeProfile = {
  id: 'claude-observed-wire-2026-07-20',
  provider: TARGET,
  // No authoritative Claude persistence schema is available in the checkout.
  // Keeping this coordinate observation-scoped prevents green structure tests
  // from being misreported as support for every Claude Code version.
  evidence: { observedAt: '2026-07-20' },
} as const satisfies NativeResumeProfile<typeof TARGET>

export const claudeNativeResumeProjector: NativeResumeProjector<
  typeof TARGET,
  ClaudeNativeResumeOptions,
  typeof claudeNativeResumeProfile
> = {
  provider: TARGET,
  profile: claudeNativeResumeProfile,
  projectNativeResume: projectClaudeNativeResume,
}

export function projectClaudeNativeResume(
  conversation: ConversationDocument,
  options: ClaudeNativeResumeOptions,
): NativeResumeProjectionResult<typeof TARGET, typeof claudeNativeResumeProfile> {
  const values: Record<string, unknown>[] = []
  const changes: ProjectionChange[] = []
  const makeId = options.idFactory ?? archiveId
  let parentUuid: string | null = null
  let sequence = 0
  let pendingAssistant: Array<ConversationMessage | ConversationToolCall | Extract<ConversationEntry, { kind: 'reasoning' }>> = []
  let pendingResults: ConversationToolResult[] = []
  const toolPairing = pairConversationTools(conversation.entries)
  const nonAdjacentToolEntries = invalidClaudeToolPairEntries(conversation.entries, toolPairing.pairs)
  const preserveNativeContent = conversation.sourceProvider === TARGET

  const emit = (entry: ConversationEntry, suffix: string, partial: Record<string, unknown>): string => {
    const uuid = makeId(`${options.targetSessionId}:resume:${sequence}:${suffix}`)
    sequence += 1
    values.push({
      parentUuid,
      isSidechain: false,
      userType: 'external',
      entrypoint: options.entrypoint ?? 'cli',
      sessionId: options.targetSessionId,
      cwd: options.cwd,
      gitBranch: options.gitBranch ?? '',
      version: options.version,
      uuid,
      timestamp: entry.timestamp ?? options.now,
      ...partial,
    })
    parentUuid = uuid
    return uuid
  }

  const flushAssistant = (): void => {
    if (pendingAssistant.length === 0) return
    const first = pendingAssistant[0]!
    const blocks: unknown[] = []
    let hasToolCall = false
    for (const entry of pendingAssistant) {
      const before = blocks.length
      if (entry.kind === 'message') blocks.push(...claudeMessageContent(entry, changes, preserveNativeContent))
      else if (entry.kind === 'reasoning') {
        if (!preserveNativeContent) {
          // WHY foreign reasoning is dropped rather than copied as a Claude
          // thinking block: signatures are provider-authenticated. Codex
          // encrypted_content is not a Claude signature, while an unsigned
          // historical thinking block is also not a valid native resume shape.
          // Ordinary assistant messages retain the model-visible result.
          changes.push(claudeChange(
            entry,
            'dropped',
            'native-resume.reasoning.foreign-dropped',
            'Dropped foreign provider reasoning because Claude cannot authenticate its thinking signature.',
          ))
          continue
        }
        if (entry.text.trim().length > 0) {
          blocks.push({
            type: 'thinking',
            thinking: entry.text,
            ...(entry.encrypted === null ? {} : { signature: entry.encrypted }),
          })
        }
      } else {
        hasToolCall = true
        blocks.push({
          type: 'tool_use',
          id: entry.callId,
          name: entry.name,
          input: claudeToolInput(entry, changes),
        })
      }
      changes.push(blocks.length > before
        ? preserved(entry, entry.kind)
        : claudeChange(
            entry,
            'dropped',
            'native-resume.message.empty-after-filtering',
            'Dropped an assistant message after removing content Claude cannot resume natively.',
          ))
    }
    if (blocks.length > 0) {
      const messageId = `msg_${makeId(`${options.targetSessionId}:message:${sequence}`).replace(/-/g, '')}`
      emit(first, 'assistant', {
        type: 'assistant',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model: options.model,
          content: blocks,
          stop_reason: hasToolCall ? 'tool_use' : 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      })
    }
    pendingAssistant = []
  }

  const flushResults = (): void => {
    if (pendingResults.length === 0) return
    const first = pendingResults[0]!
    emit(first, 'tool-results', {
      type: 'user',
      message: {
        role: 'user',
        content: pendingResults.map(entry => ({
          type: 'tool_result',
          tool_use_id: entry.callId,
          content: claudeToolResultContent(entry, changes),
          ...(entry.isError === null ? {} : { is_error: entry.isError }),
        })),
      },
    })
    for (const entry of pendingResults) changes.push(preserved(entry, 'tool-result'))
    pendingResults = []
  }

  const flush = (): void => {
    flushAssistant()
    flushResults()
  }

  for (const [entryIndex, entry] of conversation.entries.entries()) {
    if (toolPairing.unmatchedEntryIndexes.has(entryIndex) || nonAdjacentToolEntries.has(entryIndex)) {
      const nonAdjacent = nonAdjacentToolEntries.has(entryIndex)
      changes.push(claudeChange(
        entry,
        'dropped',
        nonAdjacent
          ? `native-resume.${entry.kind}.non-adjacent-dropped`
          : `native-resume.${entry.kind}.unmatched-dropped`,
        nonAdjacent
          ? `Dropped a ${entry.kind} whose call cycle crosses a user or compaction boundary that Claude cannot resume natively.`
          : `Dropped an unmatched ${entry.kind} so Claude does not synthesize or remove history during resume.`,
      ))
      continue
    }
    if (entry.kind === 'opaque') {
      changes.push(claudeChange(
        entry,
        'dropped',
        'native-resume.opaque.dropped',
        'Dropped an archive-only source record from the native Claude transcript.',
      ))
      continue
    }
    if (entry.kind === 'message') {
      if (entry.role === 'assistant') {
        flushResults()
        pendingAssistant.push(entry)
        continue
      }
      if (entry.role === 'developer' || entry.role === 'system') {
        changes.push(claudeChange(
          entry,
          'dropped',
          `native-resume.message.${entry.role}.dropped`,
          `Dropped a ${entry.role} message because Claude persistence has no observed native conversation role for it.`,
        ))
        continue
      }
      flush()
      const content = claudeMessageContent(entry, changes, preserveNativeContent)
      if (content.length === 0) {
        changes.push(claudeChange(
          entry,
          'dropped',
          'native-resume.message.empty-after-filtering',
          'Dropped a user message after removing content Claude cannot resume natively.',
        ))
        continue
      }
      emit(entry, 'user', {
        type: 'user',
        message: {
          role: 'user',
          // WHY plain human prompts use Claude's scalar wire shape even though
          // a one-element text-block array is semantically equivalent: the
          // native resume discovery path extracts the first prompt before it
          // loads the conversation, and current Claude releases do not index
          // the array form as an ordinary resumable prompt. Block arrays stay
          // necessary for images/documents and therefore remain the fallback.
          content: claudeUserContent(content),
        },
      })
      changes.push(preserved(entry, 'message'))
      continue
    }
    if (entry.kind === 'reasoning' || entry.kind === 'tool-call') {
      flushResults()
      pendingAssistant.push(entry)
      continue
    }
    if (entry.kind === 'tool-result') {
      flushAssistant()
      pendingResults.push(entry)
      continue
    }
    flush()
    const boundaryUuid = emit(entry, 'compact-boundary', {
      type: 'system',
      subtype: 'compact_boundary',
      content: entry.summary,
      compactMetadata: { message: entry.summary },
    })
    emit(entry, 'compact-summary', {
      type: 'user',
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
      message: { role: 'user', content: [{ type: 'text', text: entry.summary }] },
      // WHY the explicit field mirrors observed Claude compaction records: the
      // summary must thread directly from its boundary even if emit internals
      // later gain another synthesized record between the two.
      parentUuid: boundaryUuid,
    })
    changes.push(preserved(entry, 'compaction'))
  }
  flush()

  return {
    profile: 'native-resume',
    targetProvider: TARGET,
    providerProfile: claudeNativeResumeProfile,
    values,
    report: createProjectionReport('native-resume', conversation.sourceProvider, TARGET, changes),
  }
}

function claudeUserContent(content: unknown[]): unknown {
  if (content.length !== 1) return content
  const only = content[0]
  if (!isRecord(only) || only.type !== 'text' || typeof only.text !== 'string') return content
  return only.text
}

function claudeToolInput(
  entry: ConversationToolCall,
  changes: ProjectionChange[],
): Record<string, unknown> {
  if (isRecord(entry.input)) return entry.input
  if (typeof entry.input === 'string') {
    try {
      const parsed = JSON.parse(entry.input) as unknown
      if (isRecord(parsed)) {
        changes.push(claudeChange(
          entry,
          'repaired',
          'native-resume.tool-call.input-json-repaired',
          'Parsed JSON-encoded tool input into the object Claude requires for historical tool_use blocks.',
        ))
        return parsed
      }
    } catch {
      // A Codex custom_tool_call intentionally carries opaque text rather than
      // JSON. Falling through preserves that text in a legal object envelope.
    }
  }
  // WHY wrapping is mandatory rather than a lossy drop: Claude's Messages API
  // rejects the ENTIRE resumed conversation when any historical tool_use.input
  // is a string, array, primitive, or null. Codex legitimately persists opaque
  // custom-tool input as a string, so forwarding the neutral `unknown` value
  // made every such Codex -> Claude translation render successfully in the TUI
  // and then fail only when the next prompt reached the API. The generic
  // `input` envelope keeps the original value inspectable without claiming we
  // know a provider-specific argument name for arbitrary future tools.
  changes.push(claudeChange(
    entry,
    'repaired',
    'native-resume.tool-call.input-object-repaired',
    'Wrapped non-object tool input in the object Claude requires for historical tool_use blocks.',
  ))
  return { input: entry.input }
}

function claudeToolResultContent(
  entry: ConversationToolResult,
  changes: ProjectionChange[],
): unknown {
  if (typeof entry.output === 'string') return entry.output
  if (!Array.isArray(entry.output)) {
    changes.push(claudeChange(
      entry,
      'repaired',
      'native-resume.tool-result.content-repaired',
      'Serialized non-string tool output into content accepted by Claude historical tool_result blocks.',
    ))
    return printableJson(entry.output)
  }

  let repaired = false
  const blocks = entry.output.map(value => {
    if (isRecord(value)) {
      if (
        (value.type === 'input_text' || value.type === 'output_text') &&
        typeof value.text === 'string'
      ) {
        repaired = true
        return { type: 'text', text: value.text }
      }
      if (
        value.type === 'text' ||
        value.type === 'document' ||
        value.type === 'image' ||
        value.type === 'search_result' ||
        value.type === 'tool_reference'
      ) {
        return value
      }
    }
    repaired = true
    return { type: 'text', text: printableJson(value) }
  })
  if (repaired) {
    // WHY content tags need target normalization even though the neutral tool
    // result deliberately keeps `output: unknown`: Codex emits arrays of
    // Responses API `input_text` blocks, while Claude accepts only Messages API
    // `text` blocks in historical tool_result content. The TUI renders the
    // invalid history without complaint and the API rejects it only on the next
    // prompt, so this conversion belongs at the native-resume boundary.
    changes.push(claudeChange(
      entry,
      'repaired',
      'native-resume.tool-result.content-blocks-repaired',
      'Converted provider-specific tool output blocks into content tags accepted by Claude.',
    ))
  }
  return blocks
}

function printableJson(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function claudeMessageContent(
  entry: ConversationMessage,
  changes: ProjectionChange[],
  preserveNativeContent: boolean,
): unknown[] {
  const content: unknown[] = []
  for (const item of entry.content) {
    if (item.kind === 'text') {
      content.push({ type: 'text', text: item.text })
      continue
    }
    if (isRecord(item.value)) {
      // WHY `opaque` items go through the same decision as images: a Claude
      // transcript written by the projector BEFORE #29 carries the foreign part
      // verbatim, and the Claude decoder reads that stray `{type:'file', …}`
      // block back as `opaque`. The same-provider branch below would then copy
      // it verbatim again on duplicate or rewind — its "the installed provider
      // already wrote and loaded it" argument is false for this block, because
      // this package wrote it and the API has already rejected it. Re-encoding
      // it here is what gives an already-poisoned session a way out inside
      // Claude. An opaque value is never treated as `native`: only the decoder's
      // own `image` / `document` kinds vouch for a Claude-shaped block.
      const block = claudeAttachmentBlock(item.value)
      if (block.kind === 'native' && item.kind !== 'opaque') {
        content.push({ ...item.value })
        continue
      }
      if (block.kind === 'repaired') {
        content.push(block.value)
        changes.push(claudeChange(
          entry,
          'repaired',
          `native-resume.content.${item.kind}.repaired`,
          `Re-encoded a foreign ${item.kind} part as a Claude base64 ${block.value.type} block.`,
        ))
        continue
      }
      // Unrepresentable: fall through to the drop below so the loss is on the
      // record instead of on the wire.
    }
    if (preserveNativeContent && item.kind === 'opaque' && isRecord(item.value)) {
      // WHY same-provider duplication may retain an unknown block that the
      // installed provider already wrote and loaded successfully. Cross-
      // provider projection still drops it because the target has no evidence
      // for that wire shape, but deleting it from a same-provider clone is a
      // silent semantic regression from the former retargeting path.
      content.push({ ...item.value })
      continue
    }
    changes.push(claudeChange(
      entry,
      'dropped',
      `native-resume.content.${item.kind}.dropped`,
      `Dropped ${item.kind} content without an observed native Claude representation.`,
    ))
  }
  return content
}

type ClaudeAttachmentBlock =
  | { kind: 'native' }
  | {
      kind: 'repaired'
      value: {
        type: 'image' | 'document'
        source: { type: 'base64'; media_type: string; data: string }
      }
    }
  | { kind: 'unrepresentable' }

/**
 * Decide what a neutral `image` / `document` value becomes in a Claude file.
 *
 * WHY this exists (#29): the neutral content item keeps the SOURCE provider's
 * native part as `value`, and this projector used to copy it verbatim. The
 * OpenCode decoder wraps `{type:'file', mime, url:'data:…', id:'prt_…',
 * sessionID, messageID, …}` and the Codex decoder wraps
 * `{type:'input_image', image_url}`. Written into a Claude transcript unchanged,
 * either shape is accepted by the TUI — it renders the history without
 * complaint — and rejected by the API on the very next prompt:
 *
 *   400 messages.985.content.1: Input tag 'file' found using 'type' does not
 *   match any of the expected tags: …, 'document', 'image', …
 *
 * (recorded 2026-09-18 on an OpenCode → Claude switch, Claude Code 2.1.277).
 * Because the block stays in history, every later turn fails the same way and
 * the session is unusable; before the 400 the model also answered "I can't
 * view images in this session", so the image was invisible even on the turns
 * that went through. The other two projectors already re-encode in their
 * direction (`codexImage`, `filePart`); this was the only one that did not.
 *
 * WHY only base64 data URLs are re-encoded: the observed Claude fixtures
 * (`claude-message-block-image`, `claude-message-block-document`) show
 * `source.type: 'base64'` and nothing else. A remote `https:` image (the Codex
 * `input_image` fixture shape) would need `source.type: 'url'`, which this
 * profile has no evidence for, so it is dropped with a change record rather
 * than guessed. Documents are limited to `application/pdf` for the same reason:
 * a text document would need the `source.type: 'text'` shape and a decoded
 * payload, neither observed.
 *
 * WHY the media types are a closed set and the payload is validated: the point
 * of this function is that nothing reaches the file that the API will reject on
 * the next prompt, because that failure is permanent and invisible until then.
 * `image/*` is too wide — Claude Code's own reference accepts exactly png, jpeg,
 * gif and webp (`vendor/claude-code-src/full/utils/imageResizer.ts`,
 * `ImageMediaType`), so an OpenCode session on a provider that takes HEIC or SVG
 * would have produced the very block-stays-in-history 400 this fix exists to
 * end. The same goes for a payload that is not plain base64 (RFC 2397 allows
 * percent-encoding and line breaks; the API does not) and for one over the
 * API's 5 MB base64 limit (`constants/apiLimits.ts`,
 * `API_IMAGE_MAX_BASE64_SIZE`) — Claude Code downsizes its own pastes, a foreign
 * part was never downsized. All of those fall through to the drop, where the
 * loss is on the record instead of on the wire. RFC 2397 parameters
 * (`;name=x;base64,`) and an upper-case `;BASE64,` do not match the parser
 * below and are dropped too: safe direction, and no recorded producer emits
 * them.
 *
 * A `native` result carries no value because the caller already holds the
 * block and emits its own shallow copy, exactly as it did before this function
 * existed; Claude → Claude duplication and rewind carry Claude-authored blocks,
 * and the evidence-gated rule for those is "the source already wrote it and
 * loaded it".
 */
const CLAUDE_IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])
const CLAUDE_IMAGE_MAX_BASE64_CHARS = 5 * 1024 * 1024
const PLAIN_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

function claudeAttachmentBlock(value: Record<string, unknown>): ClaudeAttachmentBlock {
  if ((value.type === 'image' || value.type === 'document') && isRecord(value.source)) {
    return { kind: 'native' }
  }
  const url = typeof value.url === 'string'
    ? value.url
    : typeof value.image_url === 'string'
      ? value.image_url
      : null
  const parsed = url === null ? null : parseBase64DataUrl(url)
  if (!parsed) return { kind: 'unrepresentable' }
  // The data URL's own media type is what the bytes are; the OpenCode `mime`
  // field is the part's claim about them and only fills in when the URL omits
  // one (`data:;base64,…` is legal).
  const mediaType = parsed.mediaType || (typeof value.mime === 'string' ? value.mime : '')
  const type = CLAUDE_IMAGE_MEDIA_TYPES.has(mediaType)
    ? 'image'
    : mediaType === 'application/pdf'
      ? 'document'
      : null
  if (type === null) return { kind: 'unrepresentable' }
  // Length first: it is O(1), and it spares the regex a multi-megabyte scan of
  // a payload that is going to be dropped anyway.
  if (type === 'image' && parsed.data.length > CLAUDE_IMAGE_MAX_BASE64_CHARS) {
    return { kind: 'unrepresentable' }
  }
  if (!PLAIN_BASE64.test(parsed.data)) return { kind: 'unrepresentable' }
  return {
    kind: 'repaired',
    value: { type, source: { type: 'base64', media_type: mediaType, data: parsed.data } },
  }
}

/**
 * Split a `data:` URL into its declared media type and base64 payload.
 *
 * Exported because attachment handling is genuinely cross-cutting and a second
 * copy of this rule drifts from this one. Agent Code's Rewind draft had its
 * own, stricter regex (`[^;,]+`) and consequently reported a legal
 * `data:;base64,…` attachment as an external REFERENCE — "the provider
 * recorded a path instead of the bytes" — with the bytes sitting right there
 * in the string. Callers that need the same answer should use this rather
 * than write a third one.
 *
 * Returns null when the URL is not base64-encoded data; an empty media type
 * is a legal result, not a failure.
 *
 * Known limit, pinned by a test rather than fixed: media-type PARAMETERS
 * before `;base64` (`data:image/png;charset=utf-8;base64,…`) are refused
 * although RFC 2397 permits them. No provider in the corpus writes one, and
 * widening the pattern changes what `claudeAttachmentBlock` will admit into a
 * projected transcript — not a decision to make as a side effect.
 */
export function parseBase64DataUrl(url: string): { mediaType: string; data: string } | null {
  // Anchored and linear so a 700k-character payload (the recorded size) costs
  // one pass; the media type stops at the first `;` or `,` per RFC 2397.
  const match = /^data:([^;,]*);base64,([\s\S]*)$/.exec(url)
  if (!match) return null
  return { mediaType: match[1] ?? '', data: match[2] ?? '' }
}

function invalidClaudeToolPairEntries(
  entries: readonly ConversationEntry[],
  pairs: ReadonlyArray<{ callIndex: number; resultIndex: number }>,
): Set<number> {
  const invalid = new Set<number>()
  for (const pair of pairs) {
    const crossesNativeBoundary = entries
      .slice(pair.callIndex + 1, pair.resultIndex)
      .some(entry => (
        entry.kind === 'compaction' ||
        (entry.kind === 'message' && entry.role === 'user')
      ))
    if (!crossesNativeBoundary) continue
    invalid.add(pair.callIndex)
    invalid.add(pair.resultIndex)
  }
  return invalid
}

function preserved(entry: ConversationEntry, kind: string): ProjectionChange {
  return claudeChange(
    entry,
    'preserved',
    `native-resume.${kind}.preserved`,
    `Projected the neutral ${kind} into the observation-scoped Claude resume profile.`,
  )
}

function claudeChange(
  entry: ConversationEntry,
  kind: ProjectionChange['kind'],
  code: string,
  message: string,
): ProjectionChange {
  const change = nativeResumeChange(entry, TARGET, kind, code, message)
  change.evidence.push(CLAUDE_NATIVE_EVIDENCE)
  return change
}

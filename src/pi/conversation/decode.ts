import type { ConversationContent, ConversationDocument, ConversationEntry, ConversationSource } from '../../conversation/types.js'
import type { ConversationDecoder } from '../../conversation/decoder.js'
import { isRecord } from '../../projection/archiveHelpers.js'
import { isGhostRuntimeArtifact } from '../../runtimeArtifact.js'

// Pi (@earendil-works/pi-coding-agent 0.87.1)
// session JSONL → the neutral conversation.
//
// WHY this decodes "what Pi would send to the model" and not "the file": a Pi
// session is a TREE. `/tree` moves the leaf and forks copy a path, but the
// abandoned turns stay in the file, and a compaction keeps an arbitrary tail of
// already-written rows. Every consumer of a ConversationDocument (provider
// switch, duplicate, rewind listing, archive) treats it as one linear
// conversation. Decoding the file in line order would hand another provider
// turns the user deliberately walked away from, and would put a compaction
// boundary AFTER the rows it keeps, which the neutral "after latest portable
// compaction" slice would then erase.
//
// Every rule here is restated from Pi's own session-manager.js / messages.js
// as SHIPPED in @earendil-works/pi-coding-agent 0.87.1 (dist/core), not
// invented. Verify against the installed dist, not a source checkout: main
// moves ahead of the release. The summary wrappers below differed by one
// newline between main and 0.87.1, and only the installed-CLI live test
// (testing/live/pi-native-resume.live.test.ts) caught it.
//
// The runtime package pi-terminal-headless has the same rules for live panes. The parser does not import it because the
// engine core must stay I/O-free and browser-safe (import-boundaries.test.ts).
// Two copies of a ~40-line walk are cheaper than that coupling, and both are
// pinned by recordings of the same pi release.

/** Pi's CURRENT_SESSION_VERSION at the pinned commit. */
const PI_SESSION_VERSION = 3

// messages.js: the exact wrappers Pi puts around summaries before they
// reach a model. Byte-identical on purpose, so a target provider sees the same
// context Pi's model saw.
const BRANCH_SUMMARY_PREFIX = 'The following is a summary of a branch that this conversation came back from:\n\n<summary>\n'
const BRANCH_SUMMARY_SUFFIX = '</summary>'

export interface PiDecodeOptions {
  /** Defaults to the header's id. */
  sessionId?: string
  /**
   * The leaf of the branch to decode. Default: the last row, which is what Pi
   * itself resumes. A live pane's `/tree` move without a summary changes the
   * leaf WITHOUT writing a row, so a host that knows the live leaf (the
   * bridge's `session_tree.newLeafId`) passes it here.
   */
  leafId?: string
}

type PiRow = Record<string, unknown> & { id: string; parentId: string | null; line: number }

export function decodePiConversation(records: readonly Record<string, unknown>[], options: PiDecodeOptions = {}): ConversationDocument {
  const { header, headerLine, rows } = normalizeRows(records)
  const branch = activeBranch(rows, options.leafId)
  const entries: ConversationEntry[] = []
  const headerSource: ConversationSource = { provider: 'pi', line: headerLine, raw: header, evidence: [] }
  entries.push({ kind: 'opaque', nativeType: 'pi.session', timestamp: stringOrNull(header.timestamp), source: headerSource })

  // buildContextEntries: only the LATEST compaction on the path is a boundary.
  // Its kept range (firstKeptEntryId..compaction) is re-sent after its
  // summary. So the compaction entry goes FIRST and the kept rows follow it in
  // their own order. Rows before the kept range stay before the boundary: they
  // are the summarized history, still part of the conversation for archive
  // and for any target that cannot use the summary.
  let latestCompactionIndex = -1
  branch.forEach((row, index) => { if (row.type === 'compaction') latestCompactionIndex = index })
  const order: Array<{ row: PiRow; superseded: boolean }> = []
  if (latestCompactionIndex < 0) {
    for (const row of branch) order.push({ row, superseded: false })
  } else {
    const compaction = branch[latestCompactionIndex]!
    const firstKept = branch.findIndex((row, index) => index < latestCompactionIndex && row.id === compaction.firstKeptEntryId)
    // A firstKeptEntryId that is not on the path before the compaction means
    // "keep nothing". Pi's appendCompaction writes its own id for that
    // (session-manager.ts `firstKeptEntryId ?? id`).
    const keptStart = firstKept < 0 ? latestCompactionIndex : firstKept
    for (const row of branch.slice(0, keptStart)) order.push({ row, superseded: false })
    order.push({ row: compaction, superseded: false })
    // An older compaction inside the kept range projects to nothing in Pi
    // ("Only the newest compaction at index zero contributes"). As a neutral
    // compaction it would sit AFTER the newest one and become "the latest".
    for (const row of branch.slice(keptStart, latestCompactionIndex)) order.push({ row, superseded: row.type === 'compaction' })
    for (const row of branch.slice(latestCompactionIndex + 1)) order.push({ row, superseded: false })
  }

  // context_edit: the LAST edit per target wins, and only edits IN CONTEXT
  // count. buildSessionProjection builds its Map from buildContextEntries, so
  // an edit on an abandoned branch or inside a summarized range never
  // applied.
  const contextStart = latestCompactionIndex < 0 ? 0 : order.findIndex(item => item.row === branch[latestCompactionIndex])
  const edits = new Map<string, PiRow>()
  for (const { row } of order.slice(contextStart)) if (row.type === 'context_edit' && typeof row.targetId === 'string') edits.set(row.targetId, row)

  for (const { row, superseded } of order) {
    const source: ConversationSource = { provider: 'pi', line: row.line, raw: records[row.line]!, evidence: [] }
    const base = { timestamp: stringOrNull(row.timestamp), source }
    if (superseded) { entries.push({ kind: 'opaque', nativeType: 'pi.compaction.superseded', ...base }); continue }
    const edit = edits.get(row.id)
    if (edit && edit.replacement === null && isEditable(row)) {
      entries.push({ kind: 'opaque', nativeType: 'pi.context-edit.removed', ...base })
      continue
    }
    const effective = edit && isRecord(edit.replacement) && isEditable(row) ? applyContentEdit(row, edit.replacement.content) : row
    for (const decoded of decodePiRow(effective)) entries.push({ ...decoded, ...base } as ConversationEntry)
  }
  const sessionId = options.sessionId ?? (typeof header.id === 'string' ? header.id : undefined)
  return { schemaVersion: 1, sourceProvider: 'pi', sourceSessionIds: sessionId ? [sessionId] : [], entries }
}

export const piConversationDecoder: ConversationDecoder<'pi', Record<string, unknown>> = {
  provider: 'pi', decode: records => decodePiConversation(records),
}

/** An entry without its timestamp/source, which the caller owns. */
export type PiDecodedEntry = DistributiveOmit<ConversationEntry, 'timestamp' | 'source'>
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/**
 * One (already normalized, already edited) Pi row → its neutral entries.
 *
 * Exported for the Pi projector. It re-decodes a Pi source row to tell
 * "unchanged" from "edited by an operation" before re-emitting the native row
 * verbatim, the same check the Grok projector does for reasoning. Sharing this
 * function is what makes that check exact.
 */
export function decodePiRow(row: Record<string, unknown>): PiDecodedEntry[] {
  const type = typeof row.type === 'string' ? row.type : null
  if (type === 'message' && isRecord(row.message)) return decodeMessage(row.message)
  if (type === 'compaction') {
    // Plaintext, authored by the model Pi used for compaction and wrapped by
    // messages.ts at send time. The neutral summary stays unwrapped, like the
    // Claude carrier, so a target applies its own framing once.
    const summary = typeof row.summary === 'string' ? row.summary : ''
    return [{ kind: 'compaction', summary, summarySource: 'carrier' }]
  }
  if (type === 'branch_summary') {
    // sessionEntryToContextMessages skips an empty summary entirely.
    if (typeof row.summary !== 'string' || !row.summary) return [{ kind: 'opaque', nativeType: 'pi.branch_summary.empty' }]
    // NOT a compaction: rows before it on the path are still sent. It is
    // context Pi composed, so it is developer context, not the user's words.
    return [{ kind: 'message', role: 'developer', content: [{ kind: 'text', text: BRANCH_SUMMARY_PREFIX + row.summary + BRANCH_SUMMARY_SUFFIX }] }]
  }
  if (type === 'custom_message') {
    // Extension-injected (pi.sendMessage). convertToLlm sends it as a user
    // message, but the user did not type it, so it is developer context.
    return [{ kind: 'message', role: 'developer', content: userContent(row.content ?? []) }]
  }
  // Header-adjacent bookkeeping, extension state (`custom`), labels, names,
  // usage, context_edit rows themselves: never model context.
  return [{ kind: 'opaque', nativeType: `pi.${type ?? 'unknown'}` }]
}

function decodeMessage(message: Record<string, unknown>): PiDecodedEntry[] {
  const role = message.role
  if (role === 'user') return [{ kind: 'message', role: 'user', content: userContent(message.content ?? []) }]
  if (role === 'assistant') {
    // transformMessages (pi-ai) skips errored and aborted replies entirely:
    // "incomplete turns that shouldn't be replayed". A target that received the
    // partial text as an ordinary assistant message would treat it as a
    // finished answer, and one that received its half-made tool calls would
    // drop them as unmatched anyway.
    if (message.stopReason === 'error' || message.stopReason === 'aborted') return [{ kind: 'opaque', nativeType: `pi.assistant.${message.stopReason}` }]
    const blocks = Array.isArray(message.content) ? message.content : []
    const out: PiDecodedEntry[] = []
    for (const block of blocks) {
      if (!isRecord(block)) continue
      if (block.type === 'thinking') {
        // A redacted block carries only provider ciphertext, in
        // thinkingSignature. The text is empty and the signature is still
        // the only replay state.
        const text = typeof block.thinking === 'string' ? block.thinking : ''
        out.push({ kind: 'reasoning', text, encrypted: typeof block.thinkingSignature === 'string' ? block.thinkingSignature : null })
      } else if (block.type === 'text' && typeof block.text === 'string') {
        out.push({ kind: 'message', role: 'assistant', content: [{ kind: 'text', text: block.text }] })
      } else if (block.type === 'toolCall' && typeof block.id === 'string' && typeof block.name === 'string') {
        out.push({ kind: 'tool-call', callId: block.id, name: block.name, input: block.arguments ?? {}, nativeKind: 'toolCall' })
      } else {
        out.push({ kind: 'message', role: 'assistant', content: [{ kind: 'opaque', nativeType: typeof block.type === 'string' ? block.type : null, value: block }] })
      }
    }
    // An empty stop reply (seen in the v1 census: content []) says nothing.
    // Opaque keeps the evidence without inventing an empty bubble.
    return out.length ? out : [{ kind: 'opaque', nativeType: 'pi.empty-assistant' }]
  }
  if (role === 'toolResult') {
    return [{
      kind: 'tool-result', callId: typeof message.toolCallId === 'string' ? message.toolCallId : '',
      output: toolOutput(message.content), isError: typeof message.isError === 'boolean' ? message.isError : null, nativeKind: 'toolResult',
    }]
  }
  if (role === 'bashExecution') {
    // `!!cmd` runs are shown to the user but excluded from model context
    // (convertToLlm). Carrying them would tell another model something Pi's
    // model never saw.
    if (message.excludeFromContext === true) return [{ kind: 'opaque', nativeType: 'pi.bashExecution.excluded' }]
    // User role: the user ran it and Pi sends it as a user turn. The app's feed
    // mapper keeps it out of View Prompts separately. That is presentation.
    // This is the context the model received.
    return [{ kind: 'message', role: 'user', content: [{ kind: 'text', text: bashExecutionToText(message) }] }]
  }
  if (role === 'custom' || role === 'hookMessage') {
    // `hookMessage` is v2's name for `custom` (normalizeRows renames it too;
    // accepting both keeps decodePiRow total for the projector's re-check).
    return [{ kind: 'message', role: 'developer', content: userContent(message.content ?? []) }]
  }
  // `system` is Pi's own snapshot of its system prompt: provider policy, never
  // carried into another provider as instructions (the Grok and Claude
  // decoders make the same call). Unknown future roles stay evidence.
  return [{ kind: 'opaque', nativeType: role === 'system' ? 'pi.system' : `pi.message.${typeof role === 'string' ? role : 'unknown'}` }]
}

/** messages.ts bashExecutionToText, byte for byte. */
function bashExecutionToText(message: Record<string, unknown>): string {
  let text = `Ran \`${String(message.command ?? '')}\`\n`
  const output = typeof message.output === 'string' ? message.output : ''
  text += output ? `\`\`\`\n${output}\n\`\`\`` : '(no output)'
  if (message.cancelled === true) text += '\n\n(command cancelled)'
  else if (typeof message.exitCode === 'number' && message.exitCode !== 0) text += `\n\nCommand exited with code ${message.exitCode}`
  if (message.truncated === true && typeof message.fullOutputPath === 'string' && message.fullOutputPath) {
    text += `\n\n[Output truncated. Full output: ${message.fullOutputPath}]`
  }
  return text
}

function userContent(content: unknown): ConversationContent[] {
  if (typeof content === 'string') return [{ kind: 'text', text: content }]
  if (!Array.isArray(content)) return []
  return content.map((block): ConversationContent => {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') return { kind: 'text', text: block.text }
    if (isRecord(block) && block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
      // pi-ai ImageContent is always inline base64. The neutral carrier is
      // the Claude-shaped block every projector already reads.
      return { kind: 'image', value: { type: 'image', source: { type: 'base64', media_type: block.mimeType, data: block.data } } }
    }
    return { kind: 'opaque', nativeType: isRecord(block) && typeof block.type === 'string' ? block.type : null, value: block }
  })
}

function toolOutput(content: unknown): unknown {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  // A text-only result is plain text. That is what every provider's tool
  // result accepts and what the Grok and Codex decoders produce. Images keep
  // the neutral image carrier so each target projector recognizes them.
  if (content.every(block => isRecord(block) && block.type === 'text')) return content.map(block => String((block as { text?: unknown }).text ?? '')).join('')
  return content.map(block => {
    if (isRecord(block) && block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
      return { type: 'image', source: { type: 'base64', media_type: block.mimeType, data: block.data } }
    }
    return block
  })
}

// session-manager.ts projectContextEntry: an edit applies to these roles
// only; anything else is passed through untouched.
function isEditable(row: PiRow): boolean {
  if (row.type === 'custom_message') return true
  if (row.type !== 'message' || !isRecord(row.message)) return false
  return ['user', 'assistant', 'toolResult', 'custom', 'hookMessage'].includes(String(row.message.role))
}

function applyContentEdit(row: PiRow, replacement: unknown): PiRow {
  if (row.type === 'custom_message') return { ...row, content: replacement }
  const message = row.message as Record<string, unknown>
  // "assistant or toolResult with a string replacement → one text block"
  const content = (message.role === 'assistant' || message.role === 'toolResult') && typeof replacement === 'string'
    ? [{ type: 'text', text: replacement }] : replacement
  return { ...row, message: { ...message, content } }
}

/**
 * Header + rows with a guaranteed id/parentId, the way Pi's own migration
 * (migrateV1ToV2 / migrateV2ToV3) leaves them. v1 gets a linear chain of
 * synthetic, line-derived ids, which are stable across re-reads and cannot
 * collide with Pi's 8-hex ids. v2's `hookMessage` role becomes `custom`.
 */
function normalizeRows(records: readonly Record<string, unknown>[]): { header: Record<string, unknown>; headerLine: number; rows: PiRow[] } {
  const headerLine = records.findIndex(record => isRecord(record) && record.type === 'session')
  // Pi writes the header first and refuses a file without one. Anything else
  // is not a Pi session, and decoding it would invent a conversation.
  if (headerLine < 0 || records.slice(0, headerLine).some(record => isRecord(record) && !isGhostRuntimeArtifact(record))) {
    throw new Error('Pi transcript must start with a session header')
  }
  const header = records[headerLine]!
  const version = typeof header.version === 'number' ? header.version : 1
  const rows: PiRow[] = []
  let previous: string | null = null
  for (let line = headerLine + 1; line < records.length; line += 1) {
    const raw = records[line]
    if (!isRecord(raw)) throw new Error(`Pi transcript record ${line} must be an object`)
    if (isGhostRuntimeArtifact(raw)) continue
    let row: PiRow = version < 2 || typeof raw.id !== 'string'
      ? { ...raw, id: `v1-${line}`, parentId: previous, line }
      : { ...raw, id: raw.id, parentId: typeof raw.parentId === 'string' ? raw.parentId : null, line }
    if (version < PI_SESSION_VERSION && row.type === 'message' && isRecord(row.message) && row.message.role === 'hookMessage') {
      row = { ...row, message: { ...row.message, role: 'custom' } }
    }
    rows.push(row)
    previous = row.id
  }
  return { header, headerLine, rows }
}

function activeBranch(rows: readonly PiRow[], leafId: string | undefined): PiRow[] {
  const byId = new Map<string, PiRow>()
  // A duplicate id can only come from a hand-edited file; the later row wins,
  // matching Pi's _buildIndex Map.set.
  for (const row of rows) byId.set(row.id, row)
  const leaf = leafId === undefined ? rows.at(-1) : byId.get(leafId)
  if (leafId !== undefined && !leaf) throw new Error(`Pi leaf ${leafId} is not in this transcript`)
  const out: PiRow[] = []
  const seen = new Set<string>()
  // `seen` guards a malformed cycle. Pi never writes one, but a corrupt file
  // must fail to a short branch, not hang the host.
  for (let cursor = leaf; cursor && !seen.has(cursor.id); cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined) {
    seen.add(cursor.id)
    out.push(cursor)
  }
  return out.reverse()
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

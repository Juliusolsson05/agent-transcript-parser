import type { ConversationContent, ConversationDocument, ConversationEntry } from '../../conversation/types.js'
import { compactionAvailability } from '../../operations/compaction.js'
import { archiveId, cloneRawRecord, isRecord, jsonText, sameProviderSourceRecords } from '../../projection/archiveHelpers.js'
import { archiveProvenance } from '../../projection/archiveProvenance.js'
import { pairConversationTools } from '../../projection/toolPairs.js'
import type { ArchiveProjectionOptions, ArchiveProjectionResult, ArchiveProjector, NativeResumeProfile, NativeResumeProjectionResult, NativeResumeProjector, ProjectionBaseOptions } from '../../projection/types.js'
import { createProjectionReport, type ProjectionChange } from '../../report/types.js'
import { parseBase64DataUrl } from '../../dataUrl.js'
import { decodePiRow } from '../conversation/decode.js'

// Neutral conversation → a Pi v3 session file that `pi --session-id <id>`
// opens as its own.
//
// Shape (pi-coding-agent 0.87.1 dist/core/session-manager.js):
//   line 0  {type:'session', version:3, id, timestamp, cwd}
//   then    rows with {type, id (8 hex), parentId, timestamp, ...}
// Pi's buildSessionPath follows parentId from the LAST row, so a linear chain
// in file order IS the conversation. There is no tree to reconstruct: the
// neutral document is already the one branch.
//
// What Pi does with foreign content at send time decides what this writes
// (pi-ai dist/api/transform-messages.js). An assistant message whose
// provider/api/model differ from the running model has its thinking turned
// into text, its signatures and redacted blocks dropped, and its tool-call ids
// normalized. Errored and aborted replies are skipped, and orphan calls get a
// synthetic "No result provided". So a foreign assistant message only needs
// an honest "not from this model" identity, and Pi itself does the rest. The
// projector never fakes a signature or pretends a message came from the model
// the user will run.

// The evidence coordinate is the SHIPPED 0.87.1 dist, which the installed-CLI
// live test loads. It is not a source commit: the source checkout used while
// writing this (earendil-works/pi@9672462, main) is newer than the release,
// and its summary wrappers already differ by a newline.
export const piNativeResumeProfile = {
  id: 'pi-jsonl-v3-0.87.1', provider: 'pi',
  evidence: { cliVersion: '0.87.1' },
} as const satisfies NativeResumeProfile<'pi'>

export interface PiNativeResumeOptions extends ProjectionBaseOptions {
  /** Written into the header. Pi scopes `--session-id` lookups per cwd. */
  cwd: string
}

export interface PiNativeResumeResult extends NativeResumeProjectionResult<'pi', typeof piNativeResumeProfile> {
  /**
   * `<ISO timestamp with : and . as ->_<id>.jsonl`, the name Pi gives every
   * file it creates and the name its `--session-id` lookup matches. The host
   * owns WHICH directory; the parser owns the naming rule so the two cannot
   * drift.
   */
  fileName: string
}

export const piNativeResumeProjector = {
  provider: 'pi', profile: piNativeResumeProfile, projectNativeResume: projectPiNativeResume,
} as const satisfies NativeResumeProjector<'pi', PiNativeResumeOptions, typeof piNativeResumeProfile>
export const piArchiveProjector: ArchiveProjector<'pi'> = { provider: 'pi', projectArchive: projectPiArchive }

/**
 * Identity of an imported assistant message. Deliberately not a real provider:
 * transformMessages compares provider+api+model with the running model, and
 * ANY mismatch takes the safe cross-model path.
 */
const IMPORTED_MODEL = { api: 'agent-code-import', provider: 'agent-code-import', model: 'imported' } as const
// pi-ai's Usage shape. The footer and cost rollups read usage.cost.total from
// every assistant message, so an absent object would be a crash, not a zero.
const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }

/** Opaque Pi rows a Pi target restores on open (see projectEntries). */
const PI_STATE_ROWS = new Set(['pi.system', 'pi.model_change', 'pi.thinking_level_change', 'pi.assistant.aborted', 'pi.assistant.error'])

/** session-manager.ts assertValidSessionId. */
const PI_SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/

export function piSessionFileName(sessionId: string, timestamp: string): string {
  return `${timestamp.replace(/[:.]/g, '-')}_${sessionId}.jsonl`
}

export function projectPiNativeResume(conversation: ConversationDocument, options: PiNativeResumeOptions): PiNativeResumeResult {
  // The id becomes part of a file name the host writes. Pi's own validator
  // is the right bar, and it also refuses path separators.
  if (!PI_SESSION_ID.test(options.targetSessionId)) throw new Error('Pi target session id is not a valid Pi session id')
  if (!options.cwd || !Number.isFinite(Date.parse(options.now))) throw new Error('Pi target cwd and timestamp are required')
  const { values, changes } = projectEntries(conversation, options, options.cwd, 'native-resume')
  return {
    profile: 'native-resume', targetProvider: 'pi', providerProfile: piNativeResumeProfile, values,
    report: createProjectionReport('native-resume', conversation.sourceProvider, 'pi', changes),
    fileName: piSessionFileName(options.targetSessionId, new Date(options.now).toISOString()),
  }
}

export function projectPiArchive(conversation: ConversationDocument, options: ArchiveProjectionOptions): ArchiveProjectionResult<'pi'> {
  // Same-provider, single-source, one raw object per line: re-emit the
  // original rows once, in FILE order. The decoder moves a compaction ahead of
  // the rows it keeps, and file order puts it back where Pi wrote it. The
  // native ids and parentIds are untouched, so the branch is still a valid
  // chain, and every unknown field survives.
  const lineSources = new Map<number, Record<string, unknown>>()
  let coherent = conversation.sourceSessionIds.length <= 1
  for (const entry of conversation.entries) {
    const previous = lineSources.get(entry.source.line)
    if (previous && previous !== entry.source.raw) coherent = false
    lineSources.set(entry.source.line, entry.source.raw)
  }
  const source = coherent && conversation.entries.every(entry => entry.source.provider === 'pi')
    ? sameProviderSourceRecords(conversation, 'pi') : null
  if (source) {
    const ordered = [...source].sort((a, b) => a.source.line - b.source.line)
    const changes = ordered.map(entry => change(entry, 'preserved', 'archive.same-provider.raw-preserved', 'Preserved the original native row once, including opaque fields.'))
    return { profile: 'archive', targetProvider: 'pi', values: ordered.map(cloneRawRecord), report: createProjectionReport('archive', conversation.sourceProvider, 'pi', changes) }
  }
  const header = conversation.entries.find(entry => entry.source.provider === 'pi' && entry.source.raw.type === 'session')
  const cwd = header && typeof header.source.raw.cwd === 'string' ? header.source.raw.cwd : ''
  const { values, changes } = projectEntries(conversation, options, cwd, 'archive', options.maxEmbeddedSourceBytes)
  return { profile: 'archive', targetProvider: 'pi', values, report: createProjectionReport('archive', conversation.sourceProvider, 'pi', changes) }
}

type AssistantBlock = Record<string, unknown>

function projectEntries(
  conversation: ConversationDocument, options: ProjectionBaseOptions, cwd: string,
  profile: 'archive' | 'native-resume', maxSourceBytes?: number,
): { values: Record<string, unknown>[]; changes: ProjectionChange[] } {
  const changes: ProjectionChange[] = []
  const rows: Record<string, unknown>[] = []
  const usedRowIds = new Set<string>()
  let parentId: string | null = null
  const nextRowId = (seed: number): string => {
    // Pi ids are 8 hex characters (generateId: randomUUID().slice(0, 8)).
    // Deterministic per target+index keeps projection pure and testable, and
    // the loop resolves the rare prefix collision the same way Pi does.
    for (let salt = 0; ; salt += 1) {
      const id = archiveId(`${options.targetSessionId}:${seed}:${salt}`).replace(/-/g, '').slice(0, 8)
      if (!usedRowIds.has(id)) { usedRowIds.add(id); return id }
    }
  }
  const stamp = (entry: ConversationEntry | undefined): string => {
    const value = entry?.timestamp
    return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : new Date(options.now).toISOString()
  }
  const append = (type: string, body: Record<string, unknown>, entry: ConversationEntry | undefined, seed: number, embed = true): Record<string, unknown> => {
    const id = nextRowId(seed)
    const row: Record<string, unknown> = { type, id, parentId, timestamp: stamp(entry), ...body }
    if (profile === 'archive' && embed && entry) row.atp_archive = archiveProvenance(entry, maxSourceBytes)
    parentId = id
    rows.push(row)
    return row
  }

  // The origin marker. `custom` rows are extension state: persisted, shown by
  // no model call (sessionEntryToContextMessages returns []). A person or an
  // agent reading the file can tell it was imported and from where, which
  // otherwise only the host's own records would say.
  append('custom', { customType: 'agent-code.import', data: { sourceProvider: conversation.sourceProvider, sourceSessionIds: conversation.sourceSessionIds } }, undefined, -1, false)

  let lastCompactionLine = -1
  const pairing = pairConversationTools(conversation.entries)
  // A tool cycle whose result lands after a new user turn or a compaction is
  // not a cycle Pi can replay. transformMessages closes the call with a
  // synthetic error at the user turn, and the late result then becomes an
  // orphan toolResult that providers reject.
  const crossing = new Set<number>()
  const boundaries = [0]
  for (const entry of conversation.entries) boundaries.push(boundaries.at(-1)! +
    (entry.kind === 'compaction' || (entry.kind === 'message' && entry.role !== 'assistant') ? 1 : 0))
  for (const pair of pairing.pairs) {
    if (boundaries[pair.resultIndex]! > boundaries[pair.callIndex + 1]!) { crossing.add(pair.callIndex); crossing.add(pair.resultIndex) }
  }
  const resultToCall = new Map(pairing.pairs.map(pair => [pair.resultIndex, pair.callIndex]))
  const callIds = new Map<number, string>()
  const usedCallIds = new Set<string>()

  // One Pi assistant message = one model response: its reasoning, text and
  // tool calls in order. Other providers split a response into several
  // records (Claude per block, Codex per response item), so consecutive
  // assistant-side entries are one message. Two consecutive native Pi
  // assistant ROWS stay two messages, because that is what Pi wrote.
  let pending: { entries: ConversationEntry[]; blocks: AssistantBlock[]; firstIndex: number } | null = null
  const flush = () => {
    if (!pending) return
    const group = pending
    pending = null
    if (group.blocks.length === 0) return
    const raw = group.entries[0]!.source.raw
    const verbatim = group.entries.every(entry => entry.source.raw === raw) && isNativeUnchanged(group.entries, raw) && isRecord(raw.message)
    // Keep the source's own model identity ONLY when the message is exactly
    // what that model produced. An edited or merged message keeps signatures
    // it no longer matches, and presenting it as same-model would make Pi
    // replay them to the provider.
    const calls = group.blocks.filter(block => block.type === 'toolCall')
    let message: Record<string, unknown>
    if (verbatim) {
      // The recorded blocks, not the rebuilt ones: provider fields the neutral
      // model has no slot for (textSignature, a toolCall's thoughtSignature)
      // are exactly what same-model replay needs. Only a call id this
      // projection had to repair is patched in, in order.
      message = cloneRawRecord(group.entries[0]!).message as Record<string, unknown>
      let call = 0
      message.content = (message.content as unknown[]).map(block => isRecord(block) && block.type === 'toolCall' ? { ...block, id: calls[call++]!.id } : block)
    } else {
      message = { role: 'assistant', content: group.blocks, ...IMPORTED_MODEL, usage: ZERO_USAGE, stopReason: calls.length ? 'toolUse' : 'stop', timestamp: Date.parse(stamp(group.entries[0])) }
    }
    append('message', { message }, group.entries[0], group.firstIndex)
  }

  for (const [index, entry] of conversation.entries.entries()) {
    const note = (kind: ProjectionChange['kind'], code: string, message: string) => changes.push(change(entry, kind, `${profile}.${code}`, message))
    if (profile === 'native-resume' && pairing.unmatchedEntryIndexes.has(index)) {
      note('dropped', 'tool.unmatched-dropped', 'Dropped unmatched native tool plumbing; no tool result was invented.'); continue
    }
    if (profile === 'native-resume' && crossing.has(index)) {
      note('dropped', 'tool.cross-boundary-dropped', 'Dropped a tool cycle crossing a user/compaction boundary.'); continue
    }

    const assistantSide = entry.kind === 'reasoning' || entry.kind === 'tool-call' || (entry.kind === 'message' && entry.role === 'assistant')
    if (!assistantSide) flush()
    else if (pending && isPiAssistantRow(entry) && isPiAssistantRow(pending.entries[0]!) && pending.entries[0]!.source.raw !== entry.source.raw) flush()

    if (assistantSide) {
      pending ??= { entries: [], blocks: [], firstIndex: index }
      pending.entries.push(entry)
      if (entry.kind === 'message') {
        for (const part of entry.content) {
          if (part.kind === 'text') pending.blocks.push({ type: 'text', text: part.text })
          else note('dropped', `content.${part.kind}.dropped`, 'Pi assistant messages carry text, thinking and tool calls only.')
        }
        note('preserved', 'message.preserved', 'Preserved assistant text in native order.')
      } else if (entry.kind === 'reasoning') {
        if (entry.source.provider === 'pi' && isNativeUnchanged([entry], entry.source.raw, true)) {
          // A Pi thinking block with its signature. Whether Pi replays the
          // signature is decided at send time by the verbatim check in flush().
          const block: AssistantBlock = { type: 'thinking', thinking: entry.text }
          if (entry.encrypted !== null) block.thinkingSignature = entry.encrypted
          if (entry.text === '' && entry.encrypted !== null) block.redacted = true
          pending.blocks.push(block)
          note('preserved', 'reasoning.native-preserved', 'Preserved Pi-owned thinking; Pi decides at send time whether its signature is replayable.')
        } else if (entry.text.trim()) {
          // Unsigned thinking on an imported-identity message: Pi shows it as
          // thinking and sends it as plain text (transformMessages, cross-model).
          pending.blocks.push({ type: 'thinking', thinking: entry.text })
          note('demoted', 'reasoning.text-demoted', 'Kept the plaintext reasoning; omitted foreign or superseded signature state.')
        } else note('dropped', 'reasoning.encrypted-dropped', 'Foreign encrypted reasoning cannot be interpreted or forged by Pi.')
      } else {
        let id = entry.callId
        if (!id || usedCallIds.has(id)) {
          id = `call_${archiveId(`${options.targetSessionId}:${index}`).replace(/-/g, '')}`
          note('repaired', 'tool.id-repaired', 'Assigned a deterministic identity to an empty or duplicate tool-call ID.')
        }
        usedCallIds.add(id); callIds.set(index, id)
        // pi-ai ToolCall.arguments is an object. Codex's function_call keeps
        // its arguments as the model's JSON TEXT, so a string that parses to
        // an object IS the object (found by the Codex round trip). Anything
        // else (a Codex custom tool's free-text input) is wrapped, not coerced.
        const args = toolArguments(entry.input)
        if (!args.native) note('repaired', 'tool.arguments-wrapped', 'Wrapped non-object tool input as {input} for Pi’s object-argument tool call shape.')
        pending.blocks.push({ type: 'toolCall', id, name: entry.name, arguments: args.value })
        note('preserved', 'tool-call.preserved', 'Preserved historical tool name and input; importing does not execute the call.')
      }
      continue
    }

    // Pi's own bookkeeping rows carry state pi restores ON OPEN:
    //   - `system` rows: the tool loadout (_restoreToolsFromTranscript returns
    //     early without one, so a duplicate would come back on the default
    //     tools, a removed `bash` included);
    //   - model_change / thinking_level_change: the session's model and
    //     thinking level;
    //   - aborted and errored replies: shown by the TUI, and never replayed
    //     (transformMessages skips them at send time).
    // They are opaque to every OTHER target, but for a Pi target an unchanged
    // row goes back as itself. A system row from a compaction's kept range
    // stays out: Pi never sends one (buildContextEntries), and placed after
    // the compaction it would shadow the compaction's newer snapshot.
    if (entry.kind === 'compaction') lastCompactionLine = entry.source.line
    if (entry.kind === 'opaque' && profile === 'native-resume' && entry.source.provider === 'pi' && PI_STATE_ROWS.has(entry.nativeType ?? '')
      && !(entry.nativeType === 'pi.system' && entry.source.line < lastCompactionLine)
      && isNativeUnchanged([entry], entry.source.raw)) {
      const native = nativeRow(entry, undefined)
      if (native) {
        append(native.type, native.body, entry, index)
        note('preserved', 'native.state-preserved', 'Re-emitted Pi session state (tool loadout, model, thinking level, or a non-replayed reply) that pi restores on open.')
        continue
      }
    }
    if (entry.kind === 'opaque') {
      if (profile === 'archive') {
        append('custom', { customType: 'atp_archive', data: archiveProvenance(entry, maxSourceBytes) }, entry, index, false)
        note('opaque', 'opaque.preserved', 'Preserved bounded archive-only source evidence as extension state Pi never sends to a model.')
      } else note('dropped', 'opaque.dropped', 'Provider-private/bookkeeping record has no portable native representation.')
      continue
    }

    // A Pi row whose meaning no operation changed goes back as itself: tool
    // `details` (the TUI's bash/edit renderers read them), bash runs, custom
    // messages and branch summaries keep their native types and display.
    if (entry.source.provider === 'pi' && isNativeUnchanged([entry], entry.source.raw)) {
      const native = nativeRow(entry, entry.kind === 'tool-result' ? callIds.get(resultToCall.get(index) ?? -1) : undefined)
      if (native) {
        const row = append(native.type, native.body, entry, index)
        // A compaction keeps nothing BEFORE itself (everything after it is
        // context anyway). This is Pi's own convention for "no kept range":
        // appendCompaction writes `firstKeptEntryId ?? id`. The source's kept
        // rows already follow it in the document.
        if (native.type === 'compaction') row.firstKeptEntryId = row.id
        // The branch Pi summarized is not in this file. Pointing at the row
        // before the summary keeps the reference resolvable, and nothing
        // reads it for context (createBranchSummaryMessage uses it for display).
        if (native.type === 'branch_summary') row.fromId = row.parentId
        note('preserved', 'native.preserved', 'Re-emitted the unchanged native Pi row with new identity.')
        continue
      }
    }

    if (entry.kind === 'message') {
      const content: Record<string, unknown>[] = []
      for (const part of entry.content) {
        if (part.kind === 'text') { content.push({ type: 'text', text: part.text }); continue }
        const image = piImage(part)
        if (image) content.push(image)
        else note('dropped', `content.${part.kind}.dropped`, 'Content is outside Pi’s text/base64-image message shape.')
      }
      if (content.length === 0) {
        if (profile === 'archive') {
          append('custom', { customType: 'atp_archive', data: archiveProvenance(entry, maxSourceBytes) }, entry, index, false)
          note('opaque', 'message.provenance-preserved', 'Preserved the original record when no native content representation exists.')
        } else note('dropped', 'message.empty-dropped', 'No supported message content remained.')
        continue
      }
      if (entry.role === 'user') {
        append('message', { message: { role: 'user', content, timestamp: Date.parse(stamp(entry)) } }, entry, index)
        note('preserved', 'message.preserved', 'Preserved user content.')
      } else {
        // Never Pi's system prompt: Pi supplies its own on load. A
        // custom_message is user-level context the model receives and the
        // TUI shows. It is labelled once, so repeated projection cannot stack
        // labels, and it is never labelled for Pi's own context.
        const label = entry.source.provider === 'pi' ? [] : [{ type: 'text', text: `[Imported ${entry.role} context]` }]
        append('custom_message', { customType: 'agent-code.imported-context', content: [...label, ...content], display: true }, entry, index)
        note(label.length ? 'demoted' : 'preserved', 'message.context-demoted', 'Preserved context as a Pi custom message, never as a native system prompt.')
      }
      continue
    }

    if (entry.kind === 'compaction') {
      // Same gate the neutral slice uses. A Codex ciphertext boundary or
      // Claude's bare placeholder is not a summary a Pi model could read.
      if (compactionAvailability(entry) !== 'portable') {
        note('dropped', 'compaction.unportable-dropped', 'No portable plaintext compaction summary exists.'); continue
      }
      const row = append('compaction', { summary: entry.summary, firstKeptEntryId: '', tokensBefore: 0, fromHook: false }, entry, index)
      row.firstKeptEntryId = row.id
      note('preserved', 'compaction.native', 'Carried the plaintext summary as a native Pi compaction that keeps nothing before it.')
      continue
    }

    // tool-result (paired by construction: unmatched/crossing ones left above
    // in native-resume; archive keeps them as evidence of what happened).
    const callIndex = resultToCall.get(index)
    const callEntry = callIndex === undefined ? undefined : conversation.entries[callIndex]
    const toolName = callEntry?.kind === 'tool-call' ? callEntry.name : 'unknown'
    const id = callIndex === undefined ? entry.callId : callIds.get(callIndex) ?? entry.callId
    const content = toolResultContent(entry.output)
    append('message', { message: { role: 'toolResult', toolCallId: id, toolName, content, isError: entry.isError === true, timestamp: Date.parse(stamp(entry)) } }, entry, index)
    note(entry.isError === null ? 'repaired' : 'preserved', 'tool-result.preserved', 'Preserved output as native text/images; an unknown error status is written as success.')
  }
  flush()

  const header = { type: 'session', version: 3, id: options.targetSessionId, timestamp: new Date(options.now).toISOString(), cwd }
  return { values: [header, ...rows], changes }
}

/**
 * Does re-decoding this Pi row give exactly these entries? That is "no
 * operation touched it" (a trimmed text, a dropped call or a context edit
 * all fail it). `subset` accepts entries that are a contiguous run of the
 * row's own, for checking one block of a message.
 */
function isNativeUnchanged(entries: readonly ConversationEntry[], raw: Record<string, unknown>, subset = false): boolean {
  if (!entries.every(entry => entry.source.provider === 'pi')) return false
  const decoded = decodePiRow(normalizeLegacy(raw)).map(entry => JSON.stringify(entry))
  const actual = entries.map(({ timestamp: _t, source: _s, ...rest }) => JSON.stringify(rest))
  if (!subset) return decoded.length === actual.length && decoded.every((value, index) => value === actual[index])
  return actual.every(value => decoded.includes(value))
}

// A v2 `hookMessage` row re-decodes the same as `custom`, but written into a
// v3 file under its old name, convertToLlm would drop it (no such role), so
// the native row is renamed on the way out.
function normalizeLegacy(raw: Record<string, unknown>): Record<string, unknown> {
  return raw.type === 'message' && isRecord(raw.message) && raw.message.role === 'hookMessage'
    ? { ...raw, message: { ...raw.message, role: 'custom' } } : raw
}

function isPiAssistantRow(entry: ConversationEntry): boolean {
  return entry.source.provider === 'pi' && isRecord(entry.source.raw.message) && entry.source.raw.message.role === 'assistant'
}

/** The row type and body (no id/parentId/timestamp) to re-emit a Pi row natively. */
function nativeRow(entry: ConversationEntry, callId: string | undefined): { type: string; body: Record<string, unknown> } | null {
  const raw = normalizeLegacy(cloneRawRecord(entry))
  const type = typeof raw.type === 'string' ? raw.type : null
  if (!type) return null
  const { type: _type, id: _id, parentId: _parent, timestamp: _timestamp, atp_archive: _archive, ...body } = raw
  if (type === 'message' && isRecord(body.message) && body.message.role === 'toolResult' && callId !== undefined) body.message.toolCallId = callId
  return { type, body }
}

function toolArguments(input: unknown): { value: Record<string, unknown>; native: boolean } {
  if (isRecord(input)) return { value: input, native: true }
  if (typeof input === 'string') {
    try {
      const parsed: unknown = JSON.parse(input)
      if (isRecord(parsed)) return { value: parsed, native: true }
    } catch { /* free text, wrapped below */ }
  }
  return { value: { input }, native: false }
}

function piImage(part: ConversationContent): Record<string, unknown> | null {
  if (part.kind !== 'image' || !isRecord(part.value)) return null
  const value = part.value
  const source = isRecord(value.source) ? value.source : null
  if (source?.type === 'base64' && typeof source.media_type === 'string' && typeof source.data === 'string') {
    return { type: 'image', data: source.data, mimeType: source.media_type }
  }
  // Grok/Codex carriers hold a URL. Only an inline data: URL has bytes Pi can
  // send, and Pi never fetches a remote image, so an https URL has no Pi form.
  const url = typeof value.url === 'string' ? value.url : typeof value.image_url === 'string' ? value.image_url
    : source?.type === 'url' && typeof source.url === 'string' ? source.url : null
  const data = url ? parseBase64DataUrl(url) : null
  return data ? { type: 'image', data: data.data, mimeType: data.mediaType } : null
}

function toolResultContent(output: unknown): Record<string, unknown>[] {
  if (typeof output === 'string') return [{ type: 'text', text: output }]
  if (!Array.isArray(output)) return [{ type: 'text', text: jsonText(output) }]
  return output.map(part => {
    const image = isRecord(part) && (part.type === 'image' || part.type === 'input_image') ? piImage({ kind: 'image', value: part }) : null
    if (image) return image
    return { type: 'text', text: isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : jsonText(part) }
  })
}

function change(entry: ConversationEntry, kind: ProjectionChange['kind'], code: string, message: string): ProjectionChange {
  return {
    kind, sourceProvider: entry.source.provider, sourceLine: entry.source.line, targetProvider: 'pi', code, message,
    evidence: [...entry.source.evidence, { provenance: 'controlled-native-observation', rule: 'pi-session-entry-shape', profile: { provider: 'pi', cliVersion: piNativeResumeProfile.evidence.cliVersion } }],
  }
}

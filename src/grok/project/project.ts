import type { ConversationContent, ConversationDocument, ConversationEntry } from '../../conversation/types.js'
import { archiveId, cloneRawRecord, isRecord, jsonText, sameProviderSourceRecords } from '../../projection/archiveHelpers.js'
import { archiveProvenance } from '../../projection/archiveProvenance.js'
import { pairConversationTools } from '../../projection/toolPairs.js'
import type { ArchiveProjectionOptions, ArchiveProjectionResult, ArchiveProjector, NativeResumeProfile, NativeResumeProjectionResult, NativeResumeProjector, ProjectionBaseOptions } from '../../projection/types.js'
import { createProjectionReport, type ProjectionChange } from '../../report/types.js'

export const grokNativeResumeProfile = {
  id: 'grok-jsonl-v1-1.0.13', provider: 'grok',
  // These are independent evidence coordinates, not a claim that the public
  // source snapshot is the build commit of the observed installed binary.
  evidence: { cliVersion: '1.0.13', sourceCommit: '72a61251fcffb464bcc687aeb5a998e5a98ec0c9' },
} as const satisfies NativeResumeProfile<'grok'>

export interface GrokNativeResumeOptions extends ProjectionBaseOptions { cwd: string; model: string }
export interface GrokNativeResumeResult extends NativeResumeProjectionResult<'grok', typeof grokNativeResumeProfile> {
  /** Host writes this beside values as summary.json, not as a JSONL line. */
  summary: {
    info: { id: string; cwd: string }
    session_summary: string
    created_at: string
    updated_at: string
    current_model_id: string
    chat_format_version: 1
    num_chat_messages: number
    num_messages: number
  }
}

export const grokNativeResumeProjector = {
  provider: 'grok', profile: grokNativeResumeProfile, projectNativeResume: projectGrokNativeResume,
} as const satisfies NativeResumeProjector<'grok', GrokNativeResumeOptions, typeof grokNativeResumeProfile>
export const grokArchiveProjector: ArchiveProjector<'grok'> = { provider: 'grok', projectArchive: projectGrokArchive }

export function projectGrokNativeResume(conversation: ConversationDocument, options: GrokNativeResumeOptions): GrokNativeResumeResult {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(options.targetSessionId)) throw new Error('Grok target session must be a UUID')
  if (!options.cwd || !options.model || !Number.isFinite(Date.parse(options.now))) throw new Error('Grok target cwd, model and timestamp are required')
  const { values, changes } = projectEntries(conversation, options, 'native-resume')
  return {
    profile: 'native-resume', targetProvider: 'grok', providerProfile: grokNativeResumeProfile, values,
    report: createProjectionReport('native-resume', conversation.sourceProvider, 'grok', changes),
    summary: {
      info: { id: options.targetSessionId, cwd: options.cwd },
      session_summary: `Imported ${conversation.sourceProvider} conversation`,
      created_at: options.now, updated_at: options.now, current_model_id: options.model,
      // Native copy.rs counts chat_history items separately from replay
      // updates. This projection emits no updates.jsonl events; the host
      // writes an empty replay file and Grok maintains counters after load.
      chat_format_version: 1, num_chat_messages: values.length, num_messages: 0,
    },
  }
}

export function projectGrokArchive(conversation: ConversationDocument, options: ArchiveProjectionOptions): ArchiveProjectionResult<'grok'> {
  const lineSources = new Map<number, Record<string, unknown>>()
  let coherent = conversation.sourceSessionIds.length <= 1
  for (const entry of conversation.entries) {
    const previous = lineSources.get(entry.source.line)
    if (previous && previous !== entry.source.raw) coherent = false
    lineSources.set(entry.source.line, entry.source.raw)
  }
  const source = coherent && conversation.entries.every(entry => entry.source.provider === 'grok')
    ? sameProviderSourceRecords(conversation, 'grok') : null
  if (source) {
    const changes = source.map(entry => change(entry, 'preserved', 'archive.same-provider.raw-preserved', 'Preserved the original native record once, including opaque fields.'))
    return { profile: 'archive', targetProvider: 'grok', values: source.map(cloneRawRecord), report: createProjectionReport('archive', conversation.sourceProvider, 'grok', changes) }
  }
  const { values, changes } = projectEntries(conversation, options, 'archive', options.maxEmbeddedSourceBytes)
  return { profile: 'archive', targetProvider: 'grok', values, report: createProjectionReport('archive', conversation.sourceProvider, 'grok', changes) }
}

function projectEntries(
  conversation: ConversationDocument, options: ProjectionBaseOptions,
  profile: 'archive' | 'native-resume', maxSourceBytes?: number,
): { values: Record<string, unknown>[]; changes: ProjectionChange[] } {
  const values: Record<string, unknown>[] = []
  const changes: ProjectionChange[] = []
  const pairing = pairConversationTools(conversation.entries)
  const crossing = new Set<number>()
  const boundaries = [0]
  for (const entry of conversation.entries) boundaries.push(boundaries.at(-1)! +
    (entry.kind === 'compaction' || (entry.kind === 'message' && entry.role === 'user') ? 1 : 0))
  for (const pair of pairing.pairs) {
    if (boundaries[pair.resultIndex]! > boundaries[pair.callIndex + 1]!) {
      crossing.add(pair.callIndex); crossing.add(pair.resultIndex)
    }
  }
  const resultToCall = new Map(pairing.pairs.map(pair => [pair.resultIndex, pair.callIndex]))
  const callIds = new Map<number, string>()
  const usedIds = new Set<string>()
  let lastAssistantSource: ConversationEntry['source'] | undefined
  const add = (value: Record<string, unknown>, entry: ConversationEntry, embedSource = true) => {
    if (profile === 'archive' && embedSource && value.type !== 'atp_archive') value.atp_archive = archiveProvenance(entry, maxSourceBytes)
    values.push(value)
    lastAssistantSource = value.type === 'assistant' ? entry.source : undefined
  }
  for (const [index, entry] of conversation.entries.entries()) {
    const note = (kind: ProjectionChange['kind'], code: string, message: string) => changes.push(change(entry, kind, `${profile}.${code}`, message))
    if (profile === 'native-resume' && pairing.unmatchedEntryIndexes.has(index)) {
      note('dropped', 'tool.unmatched-dropped', 'Dropped unmatched native tool plumbing; no tool result was invented.'); continue
    }
    if (profile === 'native-resume' && crossing.has(index)) {
      note('dropped', 'tool.cross-boundary-dropped', 'Dropped a tool cycle crossing a user/compaction boundary.'); continue
    }
    if (entry.kind === 'opaque') {
      if (profile === 'archive') {
        add({ type: 'atp_archive', payload: archiveProvenance(entry, maxSourceBytes) }, entry)
        note('opaque', 'opaque.preserved', 'Preserved bounded archive-only source evidence, not runnable native history.')
      } else note('dropped', 'opaque.dropped', 'Provider-private/bootstrap record has no portable native representation.')
      continue
    }
    if (entry.kind === 'message') {
      const content: Record<string, unknown>[] = []
      for (const part of entry.content) {
        if (part.kind === 'text') content.push({ type: 'text', text: part.text })
        else {
          const url = imageUrl(part)
          if (url !== null && entry.role !== 'assistant') content.push({ type: 'image', url })
          else note('dropped', `content.${part.kind}.dropped`, 'Content is outside the evidenced Grok text/image resume shape.')
        }
      }
      if (content.length === 0) {
        if (profile === 'archive') {
          add({ type: 'atp_archive', payload: archiveProvenance(entry, maxSourceBytes) }, entry)
          note('opaque', 'message.provenance-preserved', 'Preserved the original record when no native content representation exists.')
        } else note('dropped', 'message.empty-dropped', 'No supported message content remained.')
        continue
      }
      if (entry.role === 'assistant') {
        add({ type: 'assistant', content: content.map(part => part.text).join('\n') }, entry)
        note('preserved', 'message.preserved', 'Preserved assistant text in native order.')
      } else if (entry.role === 'user') {
        add({ type: 'user', content: content.map(part => part.type === 'text' ? { type: 'text', text: `<user_query>\n${part.text}\n</user_query>` } : part) }, entry)
        note('preserved', 'message.preserved', 'Preserved user content with the native user_query wrapper.')
      } else {
        // Never install another provider's system message as Grok's policy.
        // Native load supplies its own system prompt when none is present.
        const nativeContext = entry.role === 'developer' && entry.source.provider === 'grok' && entry.source.raw.synthetic_reason === 'compaction_meta'
        add({ type: 'user', synthetic_reason: 'compaction_meta', content: nativeContext ? content : [{ type: 'text', text: `[Imported ${entry.role} context]` }, ...content] }, entry)
        note(nativeContext ? 'preserved' : 'demoted', 'message.context-demoted', 'Preserved context without installing a native system prompt or accumulating labels on repeated projection.')
      }
      continue
    }
    if (entry.kind === 'reasoning') {
      const raw = entry.source.raw
      const rawText = Array.isArray(raw.summary) ? raw.summary.filter(isRecord).map(part => typeof part.text === 'string' ? part.text : '').join('\n') : null
      const unchanged = rawText === entry.text && (raw.encrypted_content ?? null) === entry.encrypted
      if (entry.source.provider === 'grok' && raw.type === 'reasoning' && unchanged) {
        const value = cloneRawRecord(entry)
        if (profile === 'archive') value.atp_archive = archiveProvenance(entry, 0)
        else { delete value.atp_archive; delete value._atp }
        add(value, entry, false)
        note('preserved', 'reasoning.native-preserved', 'Preserved Grok-owned reasoning without manufacturing an authentication payload.')
      } else if (entry.text.trim()) {
        add({ type: 'assistant', content: `[Imported reasoning summary]\n${entry.text}` }, entry)
        note('demoted', 'reasoning.text-demoted', 'Retained the current plaintext reasoning as labeled text; omitted foreign or superseded native signature state.')
      } else note('dropped', 'reasoning.encrypted-dropped', 'Foreign encrypted reasoning cannot be interpreted or forged by Grok.')
      continue
    }
    if (entry.kind === 'compaction') {
      if (!entry.summary.trim()) { note('dropped', 'compaction.empty-dropped', 'No portable compaction summary exists.'); continue }
      add({ type: 'user', synthetic_reason: 'compaction_meta', content: [{ type: 'text', text: `[Previous conversation summary]\n${entry.summary}` }] }, entry)
      note('demoted', 'compaction.context-demoted', 'Carried the plaintext summary as context, not a fabricated native compaction boundary.')
      continue
    }
    if (entry.kind === 'tool-call') {
      let id = entry.callId
      if (!id || usedIds.has(id)) {
        id = `call_${archiveId(`${options.targetSessionId}:${index}`)}`
        note('repaired', 'tool.id-repaired', 'Assigned a deterministic identity to an empty or duplicate tool-call ID.')
      }
      usedIds.add(id); callIds.set(index, id)
      const call = { id, name: entry.name, arguments: jsonText(entry.input) }
      const previous = values.at(-1)
      if (previous?.type === 'assistant' && lastAssistantSource?.line === entry.source.line && lastAssistantSource.provider === entry.source.provider && lastAssistantSource.raw === entry.source.raw) {
        const calls = Array.isArray(previous.tool_calls) ? previous.tool_calls : []
        previous.tool_calls = [...calls, call]
      } else add({ type: 'assistant', content: '', tool_calls: [call] }, entry)
      note('preserved', 'tool-call.preserved', 'Preserved historical tool name and input; importing does not execute the call.')
      continue
    }
    const callIndex = resultToCall.get(index)
    const id = callIndex === undefined ? entry.callId : callIds.get(callIndex) ?? entry.callId
    const images: Record<string, unknown>[] = []
    const output = Array.isArray(entry.output) ? entry.output.map(part => {
      const isImage = isRecord(part) && (part.type === 'image' || part.type === 'input_image' ||
        (part.type === 'file' && typeof part.mime === 'string' && part.mime.startsWith('image/')))
      const url = isImage ? imageUrl({ kind: 'image', value: part }) : null
      if (url) { images.push({ type: 'image', url }); return '' }
      return isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : jsonText(part)
    }).filter(Boolean).join('\n') : jsonText(entry.output)
    add({ type: 'tool_result', tool_call_id: id, content: entry.isError ? `[Tool reported an error]\n${output}` : output, ...(images.length ? { images } : {}) }, entry)
    note(entry.isError || typeof entry.output !== 'string' ? 'demoted' : 'preserved', 'tool-result.preserved', 'Preserved output as native text/images; explicit error status is carried as labeled text.')
  }
  return { values, changes }
}

function imageUrl(content: ConversationContent): string | null {
  if (content.kind !== 'image' || !isRecord(content.value)) return null
  const value = content.value
  if (typeof value.url === 'string') return value.url
  if (typeof value.image_url === 'string') return value.image_url
  const source = isRecord(value.source) ? value.source : null
  if (source?.type === 'url' && typeof source.url === 'string') return source.url
  if (source?.type === 'base64' && typeof source.media_type === 'string' && typeof source.data === 'string') return `data:${source.media_type};base64,${source.data}`
  return null
}

function change(entry: ConversationEntry, kind: ProjectionChange['kind'], code: string, message: string): ProjectionChange {
  return {
    kind, sourceProvider: entry.source.provider, sourceLine: entry.source.line, targetProvider: 'grok', code, message,
    evidence: [...entry.source.evidence, { provenance: 'pinned-upstream-source', rule: 'grok-conversation-item-shape', profile: { provider: 'grok', sourceCommit: grokNativeResumeProfile.evidence.sourceCommit } }],
  }
}

import type { ConversationContent, ConversationDocument, ConversationEntry } from '../../conversation/types.js'
import type { ConversationDecoder } from '../../conversation/decoder.js'
import { isRecord } from '../../projection/archiveHelpers.js'
import { isGhostRuntimeArtifact } from '../../runtimeArtifact.js'

/** Native chat_history.jsonl values; file/session metadata is host-owned. */
export function decodeGrokConversation(
  records: readonly Record<string, unknown>[],
  options: { sessionId?: string } = {},
): ConversationDocument {
  const entries: ConversationEntry[] = []
  let sawUserRequest = false
  for (const [line, raw] of records.entries()) {
    if (!isRecord(raw)) throw new Error(`Grok transcript record ${line} must be an object`)
    if (isGhostRuntimeArtifact(raw)) continue
    const source = { provider: 'grok', line, raw, evidence: [] }
    // Grok ConversationItems do not carry per-record timestamps. Directory
    // creation time or the host clock would fabricate ordering evidence.
    const base = { timestamp: null, source }
    const opaque = (nativeType: string | null) => entries.push({ kind: 'opaque', nativeType, ...base })
    if (raw.type === 'system') { opaque('grok.system'); continue }
    if (raw.type === 'user' && Array.isArray(raw.content)) {
      const firstText = isRecord(raw.content[0]) && typeof raw.content[0].text === 'string' ? raw.content[0].text : ''
      // The untagged bootstrap record is visible in the recorded corpus. A
      // quoted tag elsewhere in a real prompt must remain ordinary user text.
      if (!sawUserRequest && raw.prompt_index == null && records[0]?.type === 'system' && firstText.startsWith('<user_info>\n')) {
        opaque('grok.bootstrap'); continue
      }
      const reason = typeof raw.synthetic_reason === 'string' ? raw.synthetic_reason : null
      // Interjection is user-originated steering despite its synthetic tag
      // (upstream SyntheticReason::Interjection). Do not drop user intent.
      if (reason && reason !== 'compaction_meta' && reason !== 'interjection') { opaque(`grok.synthetic.${reason}`); continue }
      const content: ConversationContent[] = raw.content.map(part => {
        if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') {
          const query = /^<user_query>\n([\s\S]*)\n<\/user_query>$/.exec(part.text)
          return { kind: 'text', text: query ? query[1]! : part.text }
        }
        if (isRecord(part) && part.type === 'image' && typeof part.url === 'string') {
          return imageContent(part.url)
        }
        return { kind: 'opaque', nativeType: isRecord(part) && typeof part.type === 'string' ? part.type : null, value: part }
      })
      // compaction_meta also marks workspace prefixes, not just summaries.
      // Preserve its text as context; do not create a boundary that would
      // authorize the budget planner to erase preceding conversation.
      entries.push({ kind: 'message', role: reason === 'compaction_meta' ? 'developer' : 'user', content, ...base })
      if (reason !== 'compaction_meta') sawUserRequest = true
      continue
    }
    if (raw.type === 'assistant' && typeof raw.content === 'string') {
      if (raw.content.length) entries.push({ kind: 'message', role: 'assistant', content: [{ kind: 'text', text: raw.content }], ...base })
      if (raw.tool_calls !== undefined && !Array.isArray(raw.tool_calls)) { opaque('grok.invalid-tool-call'); continue }
      if (!raw.content && (!Array.isArray(raw.tool_calls) || raw.tool_calls.length === 0)) opaque('grok.empty-assistant')
      for (const call of Array.isArray(raw.tool_calls) ? raw.tool_calls : []) {
        if (!isRecord(call) || typeof call.id !== 'string' || !call.id || typeof call.name !== 'string' ||
          typeof call.arguments !== 'string') { opaque('grok.invalid-tool-call'); continue }
        let input: unknown
        try { input = JSON.parse(call.arguments) } catch { opaque('grok.invalid-tool-call'); continue }
        entries.push({ kind: 'tool-call', callId: call.id, name: call.name, input, nativeKind: 'function_call', ...base })
      }
      continue
    }
    // content is required by Grok's native AssistantItem serde contract. Do
    // not repair a corrupt record into a tool invocation the native loader
    // would itself quarantine; give the loss report an actionable cause.
    if (raw.type === 'assistant') { opaque('grok.invalid-assistant'); continue }
    if (raw.type === 'tool_result' && typeof raw.tool_call_id === 'string' && typeof raw.content === 'string') {
      const output = Array.isArray(raw.images) && raw.images.length
        ? [{ type: 'text', text: raw.content }, ...raw.images.map(part =>
          isRecord(part) && part.type === 'image' && typeof part.url === 'string' ? imageContent(part.url).value : part)]
        : raw.content
      entries.push({ kind: 'tool-result', callId: raw.tool_call_id, output, isError: null, nativeKind: 'tool_result', ...base })
      continue
    }
    if (raw.type === 'reasoning' && Array.isArray(raw.summary)) {
      const text = raw.summary.filter(isRecord).map(part => typeof part.text === 'string' ? part.text : '').join('\n')
      entries.push({ kind: 'reasoning', text, encrypted: typeof raw.encrypted_content === 'string' ? raw.encrypted_content : null, ...base })
      continue
    }
    // Hosted/backend tools are not local calls with invented results. Keep
    // their native evidence available to archives and report native omission.
    opaque(typeof raw.type === 'string' ? raw.type : null)
  }
  return { schemaVersion: 1, sourceProvider: 'grok', sourceSessionIds: options.sessionId ? [options.sessionId] : [], entries }
}

export const grokConversationDecoder: ConversationDecoder<'grok', Record<string, unknown>> = {
  provider: 'grok', decode: records => decodeGrokConversation(records),
}

function imageContent(url: string): Extract<ConversationContent, { kind: 'image' }> {
  // User images and tool-result images use the same existing neutral carrier;
  // copying Grok's {type:image,url} into another provider's content is invalid.
  const data = /^data:([^;,]+);base64,([\s\S]*)$/.exec(url)
  return { kind: 'image', value: { type: 'image', source: data
    ? { type: 'base64', media_type: data[1], data: data[2] }
    : { type: 'url', url } } }
}

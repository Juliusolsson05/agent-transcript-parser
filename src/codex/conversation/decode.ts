import type { ConversationContent, ConversationDocument, ConversationEntry } from '../../conversation/types.js'
import type { ConversationDecoder } from '../../conversation/decoder.js'
import { isGhostRuntimeArtifact } from '../../runtimeArtifact.js'
import type { CodexClassifiedRecord } from '../classify/types.js'

const CALL_TYPES = new Set(['function_call', 'custom_tool_call', 'local_shell_call'])
const RESULT_TYPES = new Set(['function_call_output', 'custom_tool_call_output', 'local_shell_call_output'])

export function decodeCodexConversation(records: readonly CodexClassifiedRecord[]): ConversationDocument {
  const entries: ConversationEntry[] = []
  const sessionIds = new Set<string>()
  for (const record of records) {
    if (isGhostRuntimeArtifact(record.raw)) continue
    const source = { provider: 'codex' as const, line: record.line, raw: record.raw, evidence: record.evidence }
    const timestamp = stringField(record.raw, 'timestamp')
    if (record.family === 'session-meta') {
      const id = stringField(record.payload, 'id')
      if (id) sessionIds.add(id)
      entries.push({ kind: 'opaque', nativeType: 'session_meta', timestamp, source })
      continue
    }
    if (record.family === 'response-item' && record.payload) {
      const payload = record.payload
      if (record.itemType === 'message') {
        const role = payload.role
        if (role === 'user' || role === 'assistant' || role === 'developer' || role === 'system') {
          entries.push({ kind: 'message', role, content: decodeContent(payload.content), timestamp, source })
          continue
        }
      }
      if (record.itemType && CALL_TYPES.has(record.itemType)) {
        entries.push({
          kind: 'tool-call', timestamp, source,
          callId: stringField(payload, 'call_id') ?? `codex-call-${record.line}`,
          name: stringField(payload, 'name') ?? record.itemType,
          input: payload.arguments ?? payload.input ?? payload.action,
          nativeKind: record.itemType,
        })
        continue
      }
      if (record.itemType && RESULT_TYPES.has(record.itemType)) {
        entries.push({
          kind: 'tool-result', timestamp, source,
          callId: stringField(payload, 'call_id') ?? `codex-result-${record.line}`,
          output: payload.output,
          isError: null,
          nativeKind: record.itemType,
        })
        continue
      }
      if (record.itemType === 'reasoning') {
        const summary = Array.isArray(payload.summary)
          ? payload.summary.filter(isRecord).map(value => stringField(value, 'text') ?? '').filter(Boolean).join('\n')
          : ''
        entries.push({ kind: 'reasoning', text: summary, encrypted: stringField(payload, 'encrypted_content'), timestamp, source })
        continue
      }
    }
    if (record.family === 'compacted') {
      entries.push({
        kind: 'compaction',
        summary: stringField(record.payload, 'message') ?? '',
        // WHY an empty summary is still a complete native compaction: current
        // Codex persists replacement history as provider-encrypted payload.
        // Third-party consumers need to distinguish that durable boundary from
        // a partially written Claude boundary and request a plaintext handoff
        // instead of destructively compacting the same session a second time.
        summarySource: 'encrypted',
        timestamp,
        source,
      })
      continue
    }
    // Event messages intentionally remain opaque. Codex persists user text in
    // both event_msg:user_message and response_item:message; promoting both
    // would duplicate one human prompt in the semantic conversation.
    entries.push({ kind: 'opaque', nativeType: stringField(record.raw, 'type'), timestamp, source })
  }
  return { schemaVersion: 1, sourceProvider: 'codex', sourceSessionIds: [...sessionIds], entries }
}

export const codexConversationDecoder: ConversationDecoder<'codex', CodexClassifiedRecord> = {
  provider: 'codex',
  decode: decodeCodexConversation,
}

function decodeContent(value: unknown): ConversationContent[] {
  if (!Array.isArray(value)) return []
  return value.map(item => {
    if (!isRecord(item)) return { kind: 'opaque' as const, nativeType: null, value: item }
    if ((item.type === 'input_text' || item.type === 'output_text') && typeof item.text === 'string') {
      return { kind: 'text' as const, text: item.text }
    }
    if (item.type === 'input_image') return { kind: 'image' as const, value: item }
    return { kind: 'opaque' as const, nativeType: stringField(item, 'type'), value: item }
  })
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  return record && typeof record[key] === 'string' ? record[key] as string : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

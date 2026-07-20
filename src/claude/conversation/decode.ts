import type { ConversationContent, ConversationDocument, ConversationEntry } from '../../conversation/types.js'
import type { ConversationDecoder } from '../../conversation/decoder.js'
import { isGhostRuntimeArtifact } from '../../runtimeArtifact.js'
import type { ClaudeClassifiedRecord } from '../classify/types.js'

export function decodeClaudeConversation(
  records: readonly ClaudeClassifiedRecord[],
): ConversationDocument {
  const entries: ConversationEntry[] = []
  const sessionIds = new Set<string>()
  for (const record of records) {
    if (isGhostRuntimeArtifact(record.raw)) continue
    const sessionId = stringField(record.raw, 'sessionId')
    if (sessionId) sessionIds.add(sessionId)
    const source = {
      provider: 'claude' as const,
      line: record.line,
      raw: record.raw,
      evidence: record.evidence,
    }
    const timestamp = stringField(record.raw, 'timestamp')

    if (record.family === 'user-message' || record.family === 'assistant-message') {
      const role = record.family === 'user-message' ? 'user' as const : 'assistant' as const
      const messageContent: ConversationContent[] = []
      for (const block of record.blocks) {
        if (block.family === 'text') {
          const text = isRecord(block.raw) ? stringField(block.raw, 'text') : typeof block.raw === 'string' ? block.raw : null
          if (text !== null) messageContent.push({ kind: 'text', text })
        } else if (block.family === 'thinking' && isRecord(block.raw)) {
          entries.push({
            kind: 'reasoning',
            timestamp,
            source,
            text: stringField(block.raw, 'thinking') ?? '',
            encrypted: stringField(block.raw, 'signature'),
          })
        } else if (block.family === 'tool_use' && isRecord(block.raw)) {
          entries.push({
            kind: 'tool-call',
            timestamp,
            source,
            callId: stringField(block.raw, 'id') ?? `claude-call-${record.line}-${block.index}`,
            name: stringField(block.raw, 'name') ?? 'UnknownTool',
            input: block.raw.input,
            nativeKind: 'tool_use',
          })
        } else if (block.family === 'tool_result' && isRecord(block.raw)) {
          entries.push({
            kind: 'tool-result',
            timestamp,
            source,
            callId: stringField(block.raw, 'tool_use_id') ?? `claude-result-${record.line}-${block.index}`,
            output: block.raw.content,
            isError: typeof block.raw.is_error === 'boolean' ? block.raw.is_error : null,
            nativeKind: 'tool_result',
          })
        } else if (block.family === 'image') {
          messageContent.push({ kind: 'image', value: block.raw })
        } else if (block.family === 'document') {
          messageContent.push({ kind: 'document', value: block.raw })
        } else if (block.family !== 'thinking') {
          messageContent.push({ kind: 'opaque', nativeType: block.nativeType, value: block.raw })
        }
      }
      if (messageContent.length > 0) entries.push({ kind: 'message', role, content: messageContent, timestamp, source })
      continue
    }
    if (record.family === 'system' && record.subtype === 'compact_boundary') {
      entries.push({ kind: 'compaction', summary: '', timestamp, source })
      continue
    }
    entries.push({ kind: 'opaque', nativeType: stringField(record.raw, 'type'), timestamp, source })
  }
  return { schemaVersion: 1, sourceProvider: 'claude', sourceSessionIds: [...sessionIds], entries }
}

export const claudeConversationDecoder: ConversationDecoder<'claude', ClaudeClassifiedRecord> = {
  provider: 'claude',
  decode: decodeClaudeConversation,
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  return typeof record[key] === 'string' ? record[key] as string : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

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

    if (record.family === 'user-message' && record.raw.isCompactSummary === true) {
      // WHY a compact summary is not a human turn: Claude persists one
      // semantic compaction as a boundary followed by a user-shaped carrier.
      // Promoting that carrier would both empty the compaction and replay its
      // summary as a fresh request. Prefer the carrier text when present
      // because it is the provider's explicit summary record, but keep the
      // boundary as the source address for the single neutral entry.
      const summary = textFromClaudeContent(record.message?.content)
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const candidate = entries[index]!
        if (candidate.kind !== 'compaction') continue
        // WHY the carrier must replace even non-empty boundary content:
        // current Claude writes the generic UI status "Conversation compacted"
        // into compact_boundary.content and puts the actual multi-thousand-word
        // handoff in this isCompactSummary record. Treating any non-empty
        // boundary as authoritative silently reduced real conversations to that
        // two-word placeholder during cross-provider resume.
        if (summary !== null) candidate.summary = summary
        break
      }
      continue
    }
    if (record.family === 'user-message' && record.raw.isMeta === true) {
      // WHY meta prompts stay archive-only: analysis deliberately excludes
      // these transport records from user prompt addresses. Decoding them as
      // ordinary messages would let duplicate/switch replay hidden provider
      // instructions even though rewind never presents them to the user.
      entries.push({ kind: 'opaque', nativeType: stringField(record.raw, 'type'), timestamp, source })
      continue
    }
    if (record.family === 'user-message' || record.family === 'assistant-message') {
      const role = record.family === 'user-message' ? 'user' as const : 'assistant' as const
      let messageContent: ConversationContent[] = []
      const flushMessageContent = (): void => {
        if (messageContent.length === 0) return
        entries.push({ kind: 'message', role, content: messageContent, timestamp, source })
        messageContent = []
      }
      for (const block of record.blocks) {
        if (block.family === 'text') {
          const text = isRecord(block.raw) ? stringField(block.raw, 'text') : typeof block.raw === 'string' ? block.raw : null
          if (text !== null) messageContent.push({ kind: 'text', text })
        } else if (block.family === 'thinking' && isRecord(block.raw)) {
          // WHY content is flushed at every semantic boundary: Claude allows
          // text, thinking, tools, and media to coexist in one ordered block
          // array. Buffering all text until the end moves narration across a
          // tool invocation and changes the history that native resume sees.
          flushMessageContent()
          entries.push({
            kind: 'reasoning',
            timestamp,
            source,
            text: stringField(block.raw, 'thinking') ?? '',
            encrypted: stringField(block.raw, 'signature'),
          })
        } else if (block.family === 'tool_use' && isRecord(block.raw)) {
          flushMessageContent()
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
          flushMessageContent()
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
      flushMessageContent()
      continue
    }
    if (record.family === 'system' && record.subtype === 'compact_boundary') {
      entries.push({ kind: 'compaction', summary: compactBoundarySummary(record.raw) ?? '', timestamp, source })
      continue
    }
    entries.push({ kind: 'opaque', nativeType: stringField(record.raw, 'type'), timestamp, source })
  }
  return { schemaVersion: 1, sourceProvider: 'claude', sourceSessionIds: [...sessionIds], entries }
}

function compactBoundarySummary(record: Record<string, unknown>): string | null {
  const content = stringField(record, 'content')
  if (content !== null) return content
  const metadata = isRecord(record.compactMetadata) ? record.compactMetadata : null
  return metadata ? stringField(metadata, 'message') : null
}

function textFromClaudeContent(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  const text = content
    .filter(isRecord)
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('\n')
  return text.length > 0 ? text : null
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

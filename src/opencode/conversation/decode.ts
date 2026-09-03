import type {
  ConversationContent,
  ConversationDocument,
  ConversationEntry,
} from '../../conversation/types.js'
import type { ConversationDecoder } from '../../conversation/decoder.js'
import type { OpencodeExportData, OpencodeExportMessage } from './types.js'

/** Decode the `{ info, messages }` object emitted by `opencode export`. */
export function decodeOpencodeConversation(input: unknown): ConversationDocument {
  const data = opencodeExportData(input)
  const entries: ConversationEntry[] = []
  const sessionIds = new Set<string>()
  const rootSessionId = stringField(data.info, 'id')
  if (rootSessionId) sessionIds.add(rootSessionId)

  for (const [line, message] of data.messages.entries()) {
    const info = message.info
    const role = stringField(info, 'role')
    const sessionId = stringField(info, 'sessionID')
    if (sessionId) sessionIds.add(sessionId)
    const timestamp = isoTimestamp(numberField(recordField(info, 'time'), 'created'))
    const source = {
      provider: 'opencode' as const,
      line,
      // WHY preserve the wrapper, not only `info`: parts are where every
      // content/tool fact lives. Keeping the exact native unit makes later
      // evidence/debug consumers able to reconstruct why one message fanned
      // out into several neutral entries.
      raw: message as unknown as Record<string, unknown>,
      evidence: [],
    }

    if (role === 'user') {
      const content = message.parts.flatMap(part => (
        // Compaction is provider lifecycle, not user-authored content. It gets
        // its own opaque entry below so callers can see the native boundary
        // without also embedding the same record inside a user message.
        part.type === 'compaction' ? [] : decodeUserPart(part)
      ))
      if (content.length > 0) {
        entries.push({ kind: 'message', role: 'user', content, timestamp, source })
      }
      for (const part of message.parts) {
        if (part.type === 'compaction') {
          entries.push({ kind: 'opaque', nativeType: 'compaction', timestamp, source })
        }
      }
      continue
    }

    if (role !== 'assistant') {
      entries.push({ kind: 'opaque', nativeType: role, timestamp, source })
      continue
    }

    // OpenCode stores text, reasoning, and tool cycles as ordered parts inside
    // one assistant message. Flush adjacent text into neutral messages around
    // reasoning/tools so source order survives instead of moving all prose to
    // the beginning or end of the turn.
    let text: ConversationContent[] = []
    const flushText = () => {
      if (text.length === 0) return
      entries.push({ kind: 'message', role: 'assistant', content: text, timestamp, source })
      text = []
    }
    for (const part of message.parts) {
      if (part.type === 'text' && typeof part.text === 'string') {
        text.push({ kind: 'text', text: part.text })
        continue
      }
      if (part.type === 'reasoning' && typeof part.text === 'string') {
        flushText()
        entries.push({
          kind: 'reasoning',
          text: part.text,
          encrypted: null,
          timestamp: partTimestamp(part, timestamp),
          source,
        })
        continue
      }
      if (part.type !== 'tool') {
        flushText()
        // Step/snapshot/patch and future part types are provider-private. Do
        // not guess them into assistant prose, but do retain an explicit
        // opaque coordinate so the native message cannot silently disappear
        // from fidelity reports merely because this decoder predates a part.
        entries.push({
          kind: 'opaque',
          nativeType: stringField(part, 'type'),
          timestamp: partTimestamp(part, timestamp),
          source,
        })
        continue
      }
      flushText()
      const callId = stringField(part, 'callID') ?? stringField(part, 'id')
      if (!callId) {
        entries.push({ kind: 'opaque', nativeType: 'tool', timestamp, source })
        continue
      }
      const state = recordField(part, 'state')
      entries.push({
        kind: 'tool-call',
        callId,
        name: stringField(part, 'tool') ?? 'tool',
        input: state?.input ?? {},
        nativeKind: 'tool',
        timestamp: partTimestamp(part, timestamp),
        source,
      })
      const status = stringField(state, 'status')
      if (status === 'completed' || status === 'error') {
        entries.push({
          kind: 'tool-result',
          callId,
          output: status === 'error' ? state?.error : state?.output,
          isError: status === 'error',
          nativeKind: 'tool',
          timestamp: partTimestamp(part, timestamp),
          source,
        })
      }
    }
    flushText()
  }

  return {
    schemaVersion: 1,
    sourceProvider: 'opencode',
    sourceSessionIds: [...sessionIds],
    entries,
  }
}

export const opencodeConversationDecoder: ConversationDecoder<'opencode', OpencodeExportData> = {
  provider: 'opencode',
  decode: decodeOpencodeConversation,
}

function decodeUserPart(part: Record<string, unknown>): ConversationContent[] {
  if (part.type === 'text' && typeof part.text === 'string') {
    return [{ kind: 'text', text: part.text }]
  }
  if (part.type === 'file') {
    const value = { ...part }
    const mime = stringField(part, 'mime') ?? ''
    return [{ kind: mime.startsWith('image/') ? 'image' : 'document', value }]
  }
  return [{
    kind: 'opaque',
    nativeType: stringField(part, 'type'),
    value: part,
  }]
}

function opencodeExportData(value: unknown): OpencodeExportData {
  if (!isRecord(value) || !isRecord(value.info) || !Array.isArray(value.messages)) {
    throw new Error('OpenCode export must contain object fields `info` and `messages`.')
  }
  const messages: OpencodeExportMessage[] = value.messages.map((message, index) => {
    if (!isRecord(message) || !isRecord(message.info) || !Array.isArray(message.parts)) {
      throw new Error(`OpenCode export message ${index} must contain object info and an array of parts.`)
    }
    const parts = message.parts.map((part, partIndex) => {
      if (!isRecord(part)) {
        throw new Error(`OpenCode export message ${index} part ${partIndex} must be an object.`)
      }
      return part
    })
    return { info: message.info, parts }
  })
  return { info: value.info, messages }
}

function partTimestamp(part: Record<string, unknown>, fallback: string | null): string | null {
  return isoTimestamp(numberField(recordField(part, 'time'), 'start')) ?? fallback
}

function isoTimestamp(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? null : date.toISOString()
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  return record && typeof record[key] === 'string' ? record[key] as string : null
}

function numberField(record: Record<string, unknown> | null, key: string): number | null {
  return record && typeof record[key] === 'number' && Number.isFinite(record[key])
    ? record[key] as number
    : null
}

function recordField(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  return isRecord(record[key]) ? record[key] : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

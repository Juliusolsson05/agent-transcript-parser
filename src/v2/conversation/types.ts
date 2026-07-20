import type { EvidenceClaim } from '../evidence/claim.js'

export interface ConversationSource {
  provider: 'claude' | 'codex'
  line: number
  raw: Record<string, unknown>
  evidence: EvidenceClaim[]
}

export type ConversationContent =
  | { kind: 'text'; text: string }
  | { kind: 'image'; value: unknown }
  | { kind: 'document'; value: unknown }
  | { kind: 'opaque'; nativeType: string | null; value: unknown }

interface ConversationEntryBase {
  timestamp: string | null
  source: ConversationSource
}

export interface ConversationMessage extends ConversationEntryBase {
  kind: 'message'
  role: 'user' | 'assistant' | 'developer' | 'system'
  content: ConversationContent[]
}

export interface ConversationReasoning extends ConversationEntryBase {
  kind: 'reasoning'
  text: string
  encrypted: string | null
}

export interface ConversationToolCall extends ConversationEntryBase {
  kind: 'tool-call'
  callId: string
  name: string
  input: unknown
  nativeKind: string
}

export interface ConversationToolResult extends ConversationEntryBase {
  kind: 'tool-result'
  callId: string
  output: unknown
  isError: boolean | null
  nativeKind: string
}

export interface ConversationCompaction extends ConversationEntryBase {
  kind: 'compaction'
  summary: string
}

export interface ConversationOpaque extends ConversationEntryBase {
  kind: 'opaque'
  nativeType: string | null
}

export type ConversationEntry =
  | ConversationMessage
  | ConversationReasoning
  | ConversationToolCall
  | ConversationToolResult
  | ConversationCompaction
  | ConversationOpaque

export interface ConversationDocument {
  schemaVersion: 1
  sourceProvider: 'claude' | 'codex'
  sourceSessionIds: string[]
  entries: ConversationEntry[]
}

import type { EvidenceClaim } from '../../evidence/claim.js'

export type ClaudeObservedRecordType =
  | 'agent-name'
  | 'ai-title'
  | 'attachment'
  | 'file-history-delta'
  | 'file-history-snapshot'
  | 'frame-link'
  | 'last-prompt'
  | 'mode'
  | 'permission-mode'
  | 'pr-link'
  | 'queue-operation'
  | 'relocated'
  | 'result'
  | 'started'
  | 'worktree-state'

export type ClaudeObservedSystemSubtype =
  | 'api_error'
  | 'away_summary'
  | 'codex_event_msg'
  | 'codex_session_meta'
  | 'codex_turn_context'
  | 'compact_boundary'
  | 'informational'
  | 'local_command'
  | 'model_consent_fallback'
  | 'model_refusal_fallback'
  | 'scheduled_task_fire'
  | 'turn_duration'

export type ClaudeContentBlockFamily =
  | 'text'
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'image'
  | 'document'
  | 'fallback'
  | 'opaque'

export interface ClaudeClassifiedRecordBase {
  provider: 'claude'
  line: number
  raw: Record<string, unknown>
  facts: string[]
  evidence: EvidenceClaim[]
  diagnostics: string[]
}

export interface ClaudeUserRecord extends ClaudeClassifiedRecordBase {
  family: 'user-message'
  message: Record<string, unknown> | null
  blocks: ClaudeClassifiedContentBlock[]
}

export interface ClaudeAssistantRecord extends ClaudeClassifiedRecordBase {
  family: 'assistant-message'
  message: Record<string, unknown> | null
  blocks: ClaudeClassifiedContentBlock[]
}

export interface ClaudeSystemRecord extends ClaudeClassifiedRecordBase {
  family: 'system'
  subtype: ClaudeObservedSystemSubtype | 'unknown'
}

export interface ClaudeMetadataRecord extends ClaudeClassifiedRecordBase {
  family: 'metadata'
  recordType: ClaudeObservedRecordType
}

export interface ClaudeOpaqueRecord extends ClaudeClassifiedRecordBase {
  family: 'opaque'
  nativeType: string | null
}

export type ClaudeClassifiedRecord =
  | ClaudeUserRecord
  | ClaudeAssistantRecord
  | ClaudeSystemRecord
  | ClaudeMetadataRecord
  | ClaudeOpaqueRecord

export interface ClaudeClassifiedContentBlock {
  family: ClaudeContentBlockFamily
  index: number
  raw: unknown
  nativeType: string | null
  evidence: EvidenceClaim[]
}

export interface ClaudeClassificationResult {
  provider: 'claude'
  records: ClaudeClassifiedRecord[]
  skippedLines: Array<{ line: number; kind: 'blank' | 'malformed' }>
}

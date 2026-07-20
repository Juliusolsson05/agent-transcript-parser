import type { EvidenceClaim } from '../../evidence/claim.js'

export type CodexNativeRecordFamily =
  | 'session-meta'
  | 'response-item'
  | 'event-message'
  | 'compacted'
  | 'turn-context'

export type CodexObservedExtensionType =
  | 'atp_passthrough'
  | 'world_state'
  | 'inter_agent_communication_metadata'

export interface CodexClassifiedRecordBase {
  provider: 'codex'
  line: number
  raw: Record<string, unknown>
  facts: string[]
  evidence: EvidenceClaim[]
  diagnostics: string[]
}

export interface CodexSessionMetaRecord extends CodexClassifiedRecordBase {
  family: 'session-meta'
  payload: Record<string, unknown> | null
}

export interface CodexResponseItemRecord extends CodexClassifiedRecordBase {
  family: 'response-item'
  payload: Record<string, unknown> | null
  itemType: string | null
}

export interface CodexEventMessageRecord extends CodexClassifiedRecordBase {
  family: 'event-message'
  payload: Record<string, unknown> | null
  eventType: string | null
}

export interface CodexCompactedRecord extends CodexClassifiedRecordBase {
  family: 'compacted'
  payload: Record<string, unknown> | null
}

export interface CodexTurnContextRecord extends CodexClassifiedRecordBase {
  family: 'turn-context'
  payload: Record<string, unknown> | null
}

export interface CodexExtensionRecord extends CodexClassifiedRecordBase {
  family: 'observed-extension'
  extensionType: CodexObservedExtensionType
}

export interface CodexOpaqueRecord extends CodexClassifiedRecordBase {
  family: 'opaque'
  nativeType: string | null
}

export type CodexClassifiedRecord =
  | CodexSessionMetaRecord
  | CodexResponseItemRecord
  | CodexEventMessageRecord
  | CodexCompactedRecord
  | CodexTurnContextRecord
  | CodexExtensionRecord
  | CodexOpaqueRecord

export interface CodexClassificationResult {
  provider: 'codex'
  records: CodexClassifiedRecord[]
  skippedLines: Array<{ line: number; kind: 'blank' | 'malformed' }>
}

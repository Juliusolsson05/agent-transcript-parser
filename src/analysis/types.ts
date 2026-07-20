import type { PromptReference } from '../operations/promptAddress.js'

export type TranscriptInvariantCode =
  | 'multiple-session-identities'
  | 'missing-session-meta'
  | 'multiple-session-meta'
  | 'duplicate-record-id'
  | 'dangling-parent'
  | 'unmatched-tool-call'
  | 'unmatched-tool-result'
  | 'compaction-summary-missing'
  | 'history-rollback'

export interface TranscriptInvariantDiagnostic {
  code: TranscriptInvariantCode
  severity: 'info' | 'warning' | 'error'
  line: number | null
  relatedLines: number[]
  message: string
}

export interface TranscriptGraphAnalysis {
  // Analysis results cross the provider-neutral operation boundary, so this
  // cannot be a closed list of whichever adapters happen to ship today.
  provider: string
  sessionIds: string[]
  prompts: PromptReference[]
  diagnostics: TranscriptInvariantDiagnostic[]
  toolPairs: Array<{ callLine: number; resultLine: number; callId: string }>
  compactions: Array<{ boundaryLine: number; summaryLine: number | null }>
}

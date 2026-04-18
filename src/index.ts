// Public entry point.

export { toClaude } from './toClaude.js'
export { toCodex } from './toCodex.js'
export type { ConvertOptions } from './toClaude.js'

export { cloneClaudeTranscript } from './cloneClaude.js'
export type { CloneClaudeOptions, CloneClaudeResult } from './cloneClaude.js'

export { cloneCodexRollout } from './cloneCodex.js'
export type { CloneCodexOptions, CloneCodexResult } from './cloneCodex.js'

export { detectFormat } from './detectFormat.js'

export {
  ATP_KEY,
  attachSidecar,
  ghostSidecar,
  isGhost,
  readSidecar,
  stripSidecar,
} from './sidecar.js'
export type { AtpGhostSidecar, AtpSidecar, GhostEntry } from './sidecar.js'

export {
  createGhost,
  ghostUuid,
  isGhostUuid,
  mergeWithUpstream,
  orphanGhost,
  reduceGhostLog,
  supersedeGhost,
  updateGhost,
} from './ghost.js'
export type { CreateGhostParams, MergeOptions } from './ghost.js'

export type {
  ClaudeEntry,
  ClaudeContentBlock,
  ClaudeTextBlock,
  ClaudeToolUseBlock,
  ClaudeToolResultBlock,
  ClaudeThinkingBlock,
  ClaudeMessage,
  ClaudeRole,
} from './types.js'

export type {
  CodexRolloutLine,
  CodexResponseItemPayload,
  CodexEventMsgPayload,
  CodexSessionMetaPayload,
  CodexTurnContextPayload,
  CodexMessagePayload,
  CodexFunctionCallPayload,
  CodexFunctionCallOutputPayload,
  CodexCustomToolCallPayload,
  CodexCustomToolCallOutputPayload,
  CodexReasoningPayload,
  CodexLocalShellCallPayload,
  CodexWebSearchCallPayload,
  CodexContentItem,
} from './types.js'

// Public entry point.

export { toClaude } from './toClaude.js'
export { toCodex } from './toCodex.js'
export type { ConvertOptions } from './toClaude.js'

export { detectFormat } from './detectFormat.js'

export {
  ATP_KEY,
  attachSidecar,
  readSidecar,
  stripSidecar,
} from './sidecar.js'
export type { AtpSidecar } from './sidecar.js'

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

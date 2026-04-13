// Transcript shapes for both providers plus the sidecar envelope.
// LOCAL mirrors — no import from claude-code-headless or codex-headless.
// If either format drifts, update here.
//
// Rationale for mirroring instead of importing: keeps the package
// standalone with zero runtime deps, buildable in any context
// (browser, Node, Electron renderer), and immune to churn in the
// headless packages that would otherwise force a rebuild chain.

// ---------------------------------------------------------------------------
// Sidecar
// ---------------------------------------------------------------------------

export const ATP_KEY = '_atp' as const

export type AtpSidecar =
  | { origin: 'claude'; source: ClaudeEntry }
  | { origin: 'codex'; source: CodexRolloutLine }
  /**
   * A record that was SYNTHESIZED by the converter, not derived from
   * any source. Used by toCodex when prepending a session_meta line
   * to a Claude-originated stream that had no native session_meta.
   * On the reverse trip, toClaude sees `origin: 'synthesized'` and
   * absorbs the line's payload into context WITHOUT emitting an
   * entry — so Claude→Codex→Claude doesn't gain a phantom system
   * sentinel that wasn't in the original.
   */
  | { origin: 'synthesized' }

export type WithAtp<T> = T & { _atp?: AtpSidecar }

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

export type ClaudeRole = 'user' | 'assistant'

export type ClaudeTextBlock = { type: 'text'; text: string }

export type ClaudeToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
  caller?: { type?: string } & Record<string, unknown>
  /** Round-trip metadata stashed by toClaude when the source was a
   *  Codex custom_tool_call or had codex-specific fields (namespace,
   *  kind). Claude's own transcripts never set this. */
  codex?: Record<string, unknown>
}

export type ClaudeToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  content: string | Array<{ type: string; text?: string; [k: string]: unknown }>
  is_error?: boolean
  /** Round-trip metadata from Codex function_call_output / custom_tool
   *  variants (exit_code, duration_seconds, custom_tool marker, etc). */
  codex?: Record<string, unknown>
}

export type ClaudeThinkingBlock = {
  type: 'thinking'
  thinking: string
  signature?: string
  /** Round-trip metadata from Codex reasoning blocks (encrypted_content,
   *  original id). */
  codex?: Record<string, unknown>
}

export type ClaudeContentBlock =
  | ClaudeTextBlock
  | ClaudeToolUseBlock
  | ClaudeToolResultBlock
  | ClaudeThinkingBlock
  | { type: string; [k: string]: unknown } // forward-compat

export type ClaudeMessage = {
  role: ClaudeRole
  content: string | ClaudeContentBlock[]
  model?: string
  id?: string
  usage?: Record<string, unknown>
  stop_reason?: string | null
  stop_sequence?: string | null
}

export type ClaudeEntry = WithAtp<{
  type:
    | 'user'
    | 'assistant'
    | 'system'
    | 'attachment'
    | 'file-history-snapshot'
    | string
  uuid: string
  parentUuid: string | null
  sessionId: string
  timestamp: string // ISO-8601
  message?: ClaudeMessage
  attachment?: Record<string, unknown>
  cwd?: string
  gitBranch?: string
  requestId?: string
  isSidechain?: boolean
  isMeta?: boolean
  permissionMode?: string
  version?: string
  userType?: string
  entrypoint?: string
  promptId?: string
  slug?: string
  sourceToolAssistantUUID?: string
  sourceToolUseID?: string
  toolUseResult?: Record<string, unknown>
  isCompactSummary?: boolean
  isVisibleInTranscriptOnly?: boolean
  // System/compact-boundary fields
  subtype?: string
  content?: string // for compact_boundary
  compactMetadata?: Record<string, unknown>
  // File-history-snapshot fields
  messageId?: string
  snapshot?: Record<string, unknown>
  isSnapshotUpdate?: boolean
}>

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

export type CodexContentItem =
  | { type: 'input_text'; text: string }
  | { type: 'output_text'; text: string; annotations?: unknown[] }
  | { type: 'refusal'; refusal: string }

export type CodexMessagePayload = {
  type: 'message'
  role: string // 'user' | 'assistant' | 'developer' | 'system'
  content: CodexContentItem[]
  id?: string
  end_turn?: boolean
  phase?: 'commentary' | 'final_answer' | string
}

export type CodexFunctionCallPayload = {
  type: 'function_call'
  name: string
  namespace?: string
  arguments: string // JSON-encoded
  call_id: string
}

export type CodexFunctionCallOutputItem = {
  type?: string
  text?: string
  metadata?: {
    exit_code?: number
    duration_seconds?: number
    [k: string]: unknown
  }
  [k: string]: unknown
}

export type CodexFunctionCallOutputPayload = {
  type: 'function_call_output'
  call_id: string
  output: string | CodexFunctionCallOutputItem[]
}

export type CodexCustomToolCallPayload = {
  type: 'custom_tool_call'
  call_id: string
  name: string
  input: string
  status?: string
}

export type CodexCustomToolCallOutputPayload = {
  type: 'custom_tool_call_output'
  call_id: string
  name?: string
  output: string
}

export type CodexReasoningPayload = {
  type: 'reasoning'
  id?: string
  summary?: Array<{ type: string; text?: string }>
  content?: unknown
  encrypted_content?: string
}

export type CodexLocalShellCallPayload = {
  type: 'local_shell_call'
  call_id?: string
  status?: string
  action: {
    type: string
    command?: string[]
    cmd?: string[]
    working_directory?: string
    workdir?: string
    timeout_ms?: number
    timeout_seconds?: number
    [k: string]: unknown
  }
}

export type CodexWebSearchCallPayload = {
  type: 'web_search_call'
  status?: string
  action?: { type: string; query?: string; [k: string]: unknown }
}

export type CodexResponseItemPayload =
  | CodexMessagePayload
  | CodexFunctionCallPayload
  | CodexFunctionCallOutputPayload
  | CodexCustomToolCallPayload
  | CodexCustomToolCallOutputPayload
  | CodexReasoningPayload
  | CodexLocalShellCallPayload
  | CodexWebSearchCallPayload
  | { type: string; [k: string]: unknown } // forward-compat

export type CodexEventMsgPayload =
  | { type: 'exec_approval_request'; call_id: string; command: string[]; workdir?: string }
  | { type: 'exec_command_end'; call_id: string; exit_code?: number }
  | {
      type: 'mcp_tool_call_begin'
      call_id: string
      server_name?: string
      tool_name?: string
    }
  | {
      type: 'token_count'
      input_tokens?: number
      output_tokens?: number
      cached_input_tokens?: number
      [k: string]: unknown
    }
  | {
      type: 'task_started' | 'task_complete'
      turn_id?: string
      [k: string]: unknown
    }
  | { type: 'user_message'; message?: string; [k: string]: unknown }
  | { type: 'agent_message'; message?: string; phase?: string }
  | { type: 'agent_message_delta'; delta?: string }
  | { type: 'error'; message: string; code?: string }
  | { type: string; [k: string]: unknown }

export type CodexSessionMetaPayload = {
  id: string
  timestamp: string
  cwd: string
  originator?: string
  cli_version?: string
  source?: string
  model_provider?: string
  base_instructions?: { text?: string }
  git?: {
    commit_hash?: string
    branch?: string
    repository_url?: string
    dirty?: boolean
  }
  agent_nickname?: string
  agent_role?: string
  agent_path?: string
  forked_from_id?: string
  memory_mode?: string
  [k: string]: unknown
}

export type CodexTurnContextPayload = {
  turn_id: string
  cwd?: string
  current_date?: string
  timezone?: string
  approval_policy?: string
  sandbox_policy?: Record<string, unknown>
  model?: string
  personality?: string
  collaboration_mode?: Record<string, unknown>
  [k: string]: unknown
}

export type CodexRolloutLine = WithAtp<
  | { timestamp: string; type: 'session_meta'; payload: CodexSessionMetaPayload }
  | { timestamp: string; type: 'turn_context'; payload: CodexTurnContextPayload }
  | { timestamp: string; type: 'response_item'; payload: CodexResponseItemPayload }
  | { timestamp: string; type: 'event_msg'; payload: CodexEventMsgPayload }
  | { timestamp: string; type: 'compacted'; payload: Record<string, unknown> }
  | { timestamp: string; type: string; payload: Record<string, unknown> }
>

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
  // `source` may be a single original record OR an ARRAY of records.
  // Arrays appear after toClaude's post-pass coalesces multiple Codex
  // response_items into one Claude entry (e.g. N parallel function_calls
  // into one assistant with N tool_use blocks). On reverse trip, toCodex
  // iterates the array to restore the original N-item stream, so the
  // coalescing preserves byte-identical round-trip while producing
  // on-disk JSONL that matches Claude's native bulk-turn shape.
  | { origin: 'claude'; source: ClaudeEntry | ClaudeEntry[] }
  | { origin: 'codex'; source: CodexRolloutLine | CodexRolloutLine[] }
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
  /**
   * A GHOST — a transcript record emitted by a live layer to stand in
   * for a real upstream record that does not yet exist, may never
   * exist, or is expected to be supplied by another producer.
   *
   * Ghosts are valid JSONL in either provider's native shape; native
   * parsers ignore unknown fields, so a ghost record loads unchanged
   * through `claude --resume` or Codex rollout reload. atp treats
   * ghosts as first-class: typed here, reconciled by the ghost lib,
   * and explicitly SKIPPED by both converters (ghosts are a runtime
   * artifact, not durable transcript content).
   *
   * The lifecycle is `created → updated* → (superseded | orphaned)`.
   * Deterministic uuids (see `ghostUuid` in `./ghost.ts`) let consumers
   * append freely and rely on last-write-wins at read time, so ghost
   * logs are append-only JSONL without a dedicated mutation path.
   *
   * See `docs/ghost.md` for the design rationale, reconciliation
   * semantics, and example usage. `context` is a consumer-owned
   * free-form slot carried through untouched.
   */
  | AtpGhostSidecar

/** Ghost sidecar — the fourth origin variant in {@link AtpSidecar}.
 *
 *  Exposed as a named type so consumers can write precise signatures
 *  like `function onGhost(entry: ClaudeEntry, ghost: AtpGhostSidecar)`
 *  instead of re-narrowing the union every call site. */
export type AtpGhostSidecar = {
  origin: 'ghost'
  /** Logical turn this ghost previews. MUST match the upstream turn
   *  id (message id / response id / rollout turn id, depending on
   *  provider) so reconciliation can line up ghost and real records
   *  when the real one eventually arrives. */
  turnId: string
  /** Position of the block within the turn. Assistant turns routinely
   *  contain multiple blocks (text, tool_use, thinking, tool_result);
   *  each block gets its own ghost, keyed by this index. */
  blockIndex: number
  /** First-write wall clock, ms since epoch. Set by `createGhost` and
   *  never changed by later updates. */
  createdAt: number
  /** Latest-write wall clock, ms since epoch. Bumped on every update
   *  so readers can pick the freshest snapshot per uuid. */
  updatedAt: number
  /** Real upstream uuid that replaced this ghost, when reconciled.
   *  Absent while the ghost is still the only record of its block. */
  supersededBy?: string
  /** Wall clock when the consumer gave up waiting for a real record.
   *  Orphaned ghosts keep rendering — they're the only evidence the
   *  block ever existed — but downstream UIs typically flag them. */
  orphanedAt?: number
  /** Consumer-defined metadata. atp never reads this field; it's
   *  carried through read/write/reconcile unchanged. Consumers use it
   *  for tool-specific hints (source channel, pane id, retry count,
   *  stream confidence). Kept free-form so the sidecar type doesn't
   *  leak any particular consumer's vocabulary. */
  context?: Record<string, unknown>
}

export type WithAtp<T> = T & { _atp?: AtpSidecar }

/** A ClaudeEntry whose sidecar is narrowed to the ghost variant.
 *
 *  `createGhost` returns this narrowed type, and the ghost lib's
 *  reconciler keys on it, so callers can tell at a glance whether
 *  they're holding a provisional record or an authoritative one. */
export type GhostEntry = Omit<WithAtp<ClaudeEntry>, '_atp'> & {
  _atp: AtpGhostSidecar
}

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
    | 'custom-title'
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
  // Session metadata entry fields
  customTitle?: string
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

export type CodexToolSearchCallPayload = {
  type: 'tool_search_call'
  call_id?: string
  status?: string
  execution?: string
  arguments?: unknown
}

export type CodexToolSearchOutputPayload = {
  type: 'tool_search_output'
  call_id?: string
  status?: string
  execution?: string
  tools?: unknown[]
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
  | CodexToolSearchCallPayload
  | CodexToolSearchOutputPayload
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
  | { type: 'thread_name_updated'; thread_name?: string | null; [k: string]: unknown }
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

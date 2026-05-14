// Codex rollout lines → Claude conversation entries.
//
// Short-circuits on `_atp.origin === 'claude'` for byte-identical
// round-trip when the input was previously converted from Claude.
// Otherwise dispatches on line.type + payload.type and emits one or
// more Claude entries per line, threading a mutable conversion
// context (sessionId, cwd, gitBranch, parentUuid, index) so every
// entry is stamped with stable, threading-consistent metadata.

import { attachSidecar, readSidecar, sidecarSources } from './sidecar.js'
import { normalizeOutput, parseToolInput, stableUuid } from './util.js'
import type {
  AtpSidecar,
  ClaudeContentBlock,
  ClaudeEntry,
  ClaudeMessage,
  ClaudeTextBlock,
  ClaudeToolResultBlock,
  ClaudeToolUseBlock,
  CodexCustomToolCallOutputPayload,
  CodexCustomToolCallPayload,
  CodexEventMsgPayload,
  CodexFunctionCallOutputPayload,
  CodexFunctionCallPayload,
  CodexLocalShellCallPayload,
  CodexMessagePayload,
  CodexReasoningPayload,
  CodexResponseItemPayload,
  CodexRolloutLine,
  CodexSessionMetaPayload,
  CodexToolSearchCallPayload,
  CodexToolSearchOutputPayload,
  CodexTurnContextPayload,
  CodexWebSearchCallPayload,
} from './types.js'

export type ConvertOptions = {
  /** When true, do NOT embed _atp sidecars in output. Smaller files,
   *  but round-trip fidelity is lost for anything without a direct
   *  native equivalent. Default: false. */
  lossy?: boolean
  /** Optional target session id when synthesizing a Codex session_meta
   *  line in toCodex. Exposed from the shared options type because
   *  toCodex re-exports ConvertOptions from this file. Ignored by
   *  toClaude. */
  targetSessionId?: string
  /**
   * Only consulted by `toCodex`. When true, drop Claude's self-injected
   * bootstrap / housekeeping entries before writing the Codex rollout —
   * specifically the fat `<system-reminder>` turn (tool inventory, MCP
   * instructions, skill listing, Todoist notes, etc.) and the matching
   * attachment families (`deferred_tools_delta`, `skill_listing`,
   * `todo_reminder`, `task_reminder`, `agent_listing_delta`,
   * `mcp_instructions_delta`, `agent_mention`, `output_style`,
   * `ultrathink_effort`).
   *
   * The default is OFF because round-trip fidelity tests expect
   * byte-identical output when the same transcript passes through both
   * converters. Provider-switch in Agent Code turns it ON because those
   * entries are Claude-local housekeeping that must not leak into a
   * Codex rollout the user just pivoted to.
   *
   * Ignored by `toClaude`.
   */
  dropClaudeBootstrap?: boolean
  /**
   * Only consulted by `toCodex`. When true, strip one-shot history
   * mutations from codex-origin sidecar sources before re-emitting
   * them. Specifically:
   *
   *   - drops `event_msg:thread_rolled_back` (otherwise codex re-applies
   *     `/rollback N` on every resume — observed as "jumped back N
   *     messages" after a provider switch)
   *   - drops `event_msg:turn_aborted` and `event_msg:context_compacted`
   *     (stale segment signals)
   *   - strips `replacement_history` from `compacted` lines (codex falls
   *     back to rebuilding from live user messages, which is the correct
   *     behavior when the snapshot is stale)
   *
   * The default is OFF to preserve byte-identical round-trip fidelity
   * for backup/export use cases. Agent Code's provider-switch turns it ON
   * because the output file is about to be RESUMED by codex, and
   * preserving those mutations would re-apply them on resume (dropping
   * user-visible turns the source session already committed).
   *
   * Ignored by `toClaude`.
   */
  sanitizeForResume?: boolean
}

type Ctx = {
  sessionId: string
  cwd: string
  gitBranch: string
  version?: string
  parentUuid: string | null
  index: number
  lossy: boolean
  /**
   * Claude's `normalizeMessagesForAPI` groups adjacent assistant entries
   * into a single API message when their `message.id` matches, walking
   * BACKWARD across tool_result-only user messages (see
   * claude-code-src/full/utils/messages.ts:2257 — `isToolResultMessage`
   * lets the walk-back skip user tool_result turns).
   *
   * Two failure modes this id must navigate:
   *
   *   A. All translated assistants omit `message.id`. Then
   *      `undefined === undefined` merges assistants ACROSS logical
   *      turns (tool_result-only users are transparent to the walk).
   *      Not always fatal — pairing usually survives because consecutive
   *      users merge too — but it is a latent hazard.
   *
   *   B. Every translated assistant gets a UNIQUE id (Codex's first
   *      attempt). Then Codex parallel tool calls — N `function_call`
   *      items in a row with no interleaving user — stop merging and
   *      Claude's `ensureToolResultPairing` sees each assistant with
   *      tool_use followed by another assistant, synthesizes fake
   *      `is_error: true` tool_result stubs, and strips the real
   *      tool_results as "orphaned" (messages.ts:5161-5199). Valid
   *      wire shape, but the real tool outputs are DESTROYED.
   *
   * Correct rule: all assistants that belong to the SAME logical turn
   * share one `message.id`. A new logical turn begins when we see a
   * `response_item:message` with role=user (the next user prompt).
   * Tool-call/tool-output response items within that turn keep the
   * current id, so parallel tool_use emissions merge correctly. A
   * compact boundary also resets because Codex's conversation restarts
   * around it.
   */
  turnMessageId: string | null
  turnMessageSeq: number
  callInfo: Map<
    string,
    {
      assistantUuid: string
      claudeToolName?: string
      originalToolName: string
      input: unknown
    }
  >
}

function newCtx(lossy: boolean): Ctx {
  return {
    sessionId: '',
    cwd: '',
    gitBranch: '',
    version: undefined,
    parentUuid: null,
    index: 0,
    lossy,
    turnMessageId: null,
    turnMessageSeq: 0,
    callInfo: new Map(),
  }
}

function resetTurnMessageId(ctx: Ctx): void {
  ctx.turnMessageId = null
  ctx.turnMessageSeq++
}

/**
 * Return the shared synthetic Claude `message.id` for the current Codex
 * logical turn. Lazily allocates one on first assistant emission after
 * a turn boundary — this keeps the id stable across every assistant
 * entry the translator emits within the same turn (parallel tool
 * calls, text+tool_use, reasoning+tool_use, etc.) so Claude's
 * normalizer merges them into one API message.
 *
 * The id is derived from (sessionId, line.timestamp of the emission
 * that created it, a bump counter) so repeat runs of the translator
 * against the same rollout produce identical ids. Using `ctx.index`
 * as the counter would work too but couples the id to emission order;
 * a dedicated bump field makes the id stable under refactors that
 * change when `ctx.index` is incremented.
 */
function currentTurnMessageId(ctx: Ctx, line: CodexRolloutLine): string {
  if (ctx.turnMessageId === null) {
    ctx.turnMessageId = syntheticClaudeMessageId([
      ctx.sessionId,
      ctx.turnMessageSeq,
      line.timestamp,
      'turn',
    ])
  }
  return ctx.turnMessageId
}

function summarizeToolCall(name: string, input: unknown): string {
  if (name === 'apply_patch') {
    const files = extractApplyPatchFiles(input)
    if (files.length > 0) {
      return `Applied patch touching ${files.join(', ')}.`
    }
    return 'Applied patch.'
  }
  if (name === 'parallel') {
    return 'Ran multiple tool calls in parallel.'
  }
  if (name === 'write_stdin') {
    return 'Sent input to an interactive command.'
  }
  return `Ran tool \`${name}\`.`
}

function summarizeToolResult(name: string, text: string, isError: boolean): string {
  const trimmed = text.trim()
  if (name === 'apply_patch') {
    return trimmed || (isError ? 'Patch application failed.' : 'Patch applied successfully.')
  }
  if (name === 'parallel') {
    return trimmed || (isError ? 'Parallel tool execution failed.' : 'Parallel tool execution completed.')
  }
  if (name === 'write_stdin') {
    return trimmed || (isError ? 'Interactive command input failed.' : 'Interactive command input completed.')
  }
  return trimmed || (isError ? `Tool \`${name}\` failed.` : `Tool \`${name}\` completed.`)
}

function mapToClaudeToolName(name: string): string | undefined {
  if (name === 'exec_command' || name === 'write_stdin') return 'Bash'
  return undefined
}

function toBashInput(input: unknown): Record<string, unknown> {
  if (isRecord(input)) {
    if (typeof input.cmd === 'string') {
      return {
        command: input.cmd,
        description: input.cmd,
      }
    }
    if (typeof input.chars === 'string') {
      return {
        command: input.chars,
        description: 'stdin input',
      }
    }
  }
  return {
    command: typeof input === 'string' ? input : JSON.stringify(input),
    description: 'shell command',
  }
}

function toBashToolUseResult(
  raw: unknown,
  normalizedText: string,
): Record<string, unknown> {
  const text = typeof raw === 'string' ? raw : normalizedText
  const exitCodeMatch = /Process exited with code (\d+)/.exec(text)
  const outputMatch = /\nOutput:\n([\s\S]*)$/.exec(text)
  return {
    stdout: outputMatch ? outputMatch[1] ?? '' : normalizedText,
    stderr: '',
    interrupted: false,
    ...(exitCodeMatch ? { returnCodeInterpretation: `exit ${exitCodeMatch[1]}` } : {}),
  }
}

function extractApplyPatchFiles(input: unknown): string[] {
  const text =
    typeof input === 'string'
      ? input
      : isRecord(input) && typeof input.arguments === 'string'
        ? input.arguments
        : ''
  if (text.length === 0) return []
  const files = new Set<string>()
  for (const line of text.split('\n')) {
    const m = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line.trim())
    if (m?.[1]) files.add(m[1])
  }
  return [...files]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function syntheticClaudeMessageId(parts: Array<string | number>): string {
  // `msg_<hex>` is the shape Anthropic itself uses for assistant message
  // ids. Matching it keeps any downstream tool that regex-matches
  // Anthropic ids happy — callers of this helper should pass inputs
  // that are stable across repeat translations of the same rollout so
  // the id is deterministic.
  return `msg_${stableUuid(parts).replace(/-/g, '')}`
}

/** Attach sidecar unless ctx.lossy. Also advances ctx.parentUuid +
 *  ctx.index so the next emit threads off this entry. Returns the
 *  possibly-decorated entry. */
function emit(
  ctx: Ctx,
  entry: ClaudeEntry,
  source: CodexRolloutLine,
): ClaudeEntry {
  const out = ctx.lossy ? entry : attachSidecar(entry, 'codex', source)
  ctx.parentUuid = entry.uuid
  ctx.index++
  return out
}

/** Stamp every Claude entry with the current context metadata (the
 *  fields that are position-dependent). Callers only build the shape
 *  they care about; this fills in the rest.
 *
 *  We spread `partial` LAST so caller-supplied fields (notably type
 *  and uuid) are authoritative; ctx contributes the threading
 *  metadata (parentUuid, sessionId, cwd, gitBranch) which the caller
 *  doesn't need to know about. */
function stamp(
  ctx: Ctx,
  partial: Omit<ClaudeEntry, 'parentUuid' | 'sessionId' | 'cwd' | 'gitBranch'> & {
    uuid: string
    timestamp: string
  },
): ClaudeEntry {
  return {
    parentUuid: ctx.parentUuid,
    isSidechain: false,
    userType: 'external',
    entrypoint: 'cli',
    sessionId: ctx.sessionId,
    cwd: ctx.cwd,
    gitBranch: ctx.gitBranch,
    ...(ctx.version ? { version: ctx.version } : {}),
    ...partial,
  }
}

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

export function toClaude(
  lines: readonly CodexRolloutLine[],
  opts: ConvertOptions = {},
): ClaudeEntry[] {
  const ctx = newCtx(opts.lossy === true)
  const out: ClaudeEntry[] = []

  // Dedup set for sidecar short-circuit. One Claude entry can split
  // into multiple Codex lines (a multi-block assistant turn becomes
  // one `message` + one `function_call`, sharing the same sidecar
  // source). Without deduping, the reverse trip would emit that
  // source once per line, bloating the output. Uuids are stable on
  // Claude entries, so uuid is the right dedup key.
  const seenSourceUuids = new Set<string>()

  for (const line of lines) {
    const sidecar = readSidecar(line)

    // Ghost line — a provisional record emitted by a live layer
    // (see `./ghost.ts` and `docs/ghost.md`). Ghosts are a runtime
    // artifact; they must NOT appear in a durable transcript export.
    // Skip silently. The ghost's consumer is responsible for
    // reconciling its own state before feeding a stream to a
    // converter if it wants any of that state to survive export.
    if (sidecar?.origin === 'ghost') {
      continue
    }

    // Synthesized line — toCodex emitted it as boilerplate (prepended
    // session_meta, per-turn task_started / turn_context / task_complete
    // boundary wrappers, etc.). Absorb session_meta / turn_context
    // into context; drop all other synthesized lines entirely. Without
    // this short-circuit the round-trip would gain phantom sentinel
    // entries for every turn-wrap the converter inserted.
    if (sidecar?.origin === 'synthesized') {
      if (line.type === 'session_meta') {
        mapSessionMeta(ctx, line.payload as CodexSessionMetaPayload)
      } else if (line.type === 'turn_context') {
        mapTurnContext(ctx, line.payload as CodexTurnContextPayload)
      }
      // event_msg task_started / task_complete (and any future
      // synthesized line types) drop silently — they carry no
      // information beyond what the adjacent emitted entries already
      // carry via their own sidecars.
      continue
    }

    // Short-circuit: this Codex line already carries the original
    // Claude entry it came from. Emit that directly — byte-identical.
    if (sidecar?.origin === 'claude') {
      for (const source of sidecarSources(sidecar.source)) {
        if (source.uuid && seenSourceUuids.has(source.uuid)) {
          // Fan-out: same source already emitted by a previous line.
          // Skip silently — the already-emitted entry represents all
          // of these Codex lines collectively.
          continue
        }
        if (source.uuid) seenSourceUuids.add(source.uuid)
        out.push(source)
        absorbClaudeSourceContext(ctx, source)
        ctx.parentUuid = source.uuid ?? ctx.parentUuid
        ctx.index++
      }
      continue
    }

    const entries = mapLine(ctx, line)
    for (const entry of entries) {
      out.push(emit(ctx, entry, line))
    }
  }

  // Post-pass: coalesce adjacent entries into the bulk-turn shape Claude
  // itself writes natively. This matters because Claude's resume pipeline
  // does its OWN merging in normalizeMessagesForAPI, and any edge case in
  // that path — attachment reordering breaking adjacency, a rogue
  // non-tool-result user, the ensureToolResultPairing pass synthesizing
  // fake error stubs — can desync tool_use / tool_result pairing and
  // surface as "API Error: 400 due to tool use concurrency issues" at
  // resume time. By pre-merging on our side we remove that dependency:
  // the JSONL on disk already looks the way Claude would have written
  // the same conversation natively.
  //
  // Round-trip fidelity is preserved via the sidecar array variant —
  // when two entries merge, their Codex sources concatenate into
  // `_atp.source` as an array. toCodex iterates that array on reverse.
  return coalesceForClaudeApiShape(out)
}

/**
 * Merge adjacent emitted entries into the bulk-turn shape Claude
 * writes natively. See the comment in toClaude for why this matters
 * for `claude --resume` safety.
 *
 * Merge rules:
 *
 *   - Two adjacent `assistant` entries whose `message.id` is set and
 *     equal collapse into one — their content arrays concatenate in
 *     order. If either lacks a `message.id` we refuse to merge
 *     (matching Claude's own normalizeMessagesForAPI identity check,
 *     which compares ids via `===` and would treat `undefined` as a
 *     distinct identity).
 *
 *   - Two adjacent `user` entries whose `message.content` is an array
 *     containing at least one `tool_result` block collapse into one —
 *     their content concatenates, tool_results first (matches Claude's
 *     hoistToolResults behavior). We require BOTH messages to be tool-
 *     result users so plain user prompts don't accidentally merge into
 *     prior tool-result turns.
 *
 *   - Sidecar preservation: the merged entry's `_atp.source` becomes
 *     the concatenation of each contributor's source (wrapped into an
 *     array). On reverse-trip, toCodex's short-circuit iterates the
 *     array and re-emits each original record. This keeps round-trip
 *     byte-identical even for coalesced entries.
 *
 *   - Sidecar origin must match (both 'codex' or both 'claude') — we
 *     never mix origins across a merge. If origins differ we leave the
 *     entries as-is.
 *
 * The pass is O(n) with a single left-to-right walk.
 */
function coalesceForClaudeApiShape(entries: ClaudeEntry[]): ClaudeEntry[] {
  if (entries.length < 2) return entries
  const out: ClaudeEntry[] = []
  for (const entry of entries) {
    const prev = out.length > 0 ? out[out.length - 1] : undefined
    if (prev && canMergeAssistants(prev, entry)) {
      out[out.length - 1] = mergeAssistants(prev, entry)
      continue
    }
    if (prev && canMergeToolResultUsers(prev, entry)) {
      out[out.length - 1] = mergeUsers(prev, entry)
      continue
    }
    out.push(entry)
  }
  return rethreadParentChain(out)
}

function rethreadParentChain(entries: ClaudeEntry[]): ClaudeEntry[] {
  let parentUuid: string | null = null
  return entries.map(entry => {
    if (typeof entry.uuid !== 'string' || entry.uuid.length === 0) {
      return entry
    }
    const next = {
      ...entry,
      parentUuid,
    }
    parentUuid = entry.uuid
    return next
  })
}

function canMergeAssistants(a: ClaudeEntry, b: ClaudeEntry): boolean {
  if (a.type !== 'assistant' || b.type !== 'assistant') return false
  const ida = a.message?.id
  const idb = b.message?.id
  // Both must have explicit ids and match. We never merge on undefined
  // because a missing id is semantically "unknown identity", not a
  // universal wildcard — that was the root of the original 400.
  if (typeof ida !== 'string' || typeof idb !== 'string') return false
  if (ida !== idb) return false
  // Only merge entries with compatible sidecar origins (both codex,
  // both claude, or both missing). Refuse to mix.
  return sidecarOriginCompatible(a, b)
}

function canMergeToolResultUsers(a: ClaudeEntry, b: ClaudeEntry): boolean {
  if (a.type !== 'user' || b.type !== 'user') return false
  const ac = a.message?.content
  const bc = b.message?.content
  if (!Array.isArray(ac) || !Array.isArray(bc)) return false
  const hasTr = (blocks: unknown[]) =>
    blocks.some(
      b => typeof b === 'object' && b !== null && (b as { type?: string }).type === 'tool_result',
    )
  if (!hasTr(ac) || !hasTr(bc)) return false
  return sidecarOriginCompatible(a, b)
}

function sidecarOriginCompatible(a: ClaudeEntry, b: ClaudeEntry): boolean {
  const sa = readSidecar(a)
  const sb = readSidecar(b)
  if (!sa && !sb) return true
  if (!sa || !sb) return false
  return sa.origin === sb.origin
}

function mergeAssistants(a: ClaudeEntry, b: ClaudeEntry): ClaudeEntry {
  const aContent = Array.isArray(a.message?.content) ? a.message.content : []
  const bContent = Array.isArray(b.message?.content) ? b.message.content : []
  return {
    ...a,
    message: {
      ...(a.message as NonNullable<typeof a.message>),
      content: [...aContent, ...bContent],
    },
    ...mergedSidecarField(a, b),
  }
}

function mergeUsers(a: ClaudeEntry, b: ClaudeEntry): ClaudeEntry {
  const aContent = Array.isArray(a.message?.content) ? a.message.content : []
  const bContent = Array.isArray(b.message?.content) ? b.message.content : []
  // tool_results first, other content after — mirrors claude-code-src's
  // hoistToolResults. Keeps any paired assistant tool_use visible to
  // the API's tool_use_id → tool_result linkage check.
  const combined = [...aContent, ...bContent]
  const toolResults = combined.filter(
    b => typeof b === 'object' && b !== null && (b as { type?: string }).type === 'tool_result',
  )
  const other = combined.filter(
    b =>
      !(typeof b === 'object' && b !== null && (b as { type?: string }).type === 'tool_result'),
  )
  return {
    ...a,
    message: {
      ...(a.message as NonNullable<typeof a.message>),
      content: [...toolResults, ...other],
    },
    ...mergedSidecarField(a, b),
  }
}

/**
 * Produce the `_atp` field for a merged entry by concatenating source
 * records from both contributors. Always returns `_atp.source` as an
 * array when the merge involves non-empty sources. Callers spread this
 * object onto the merged record.
 */
function mergedSidecarField(
  a: ClaudeEntry,
  b: ClaudeEntry,
): { _atp?: AtpSidecar } {
  const sa = readSidecar(a)
  const sb = readSidecar(b)
  if (!sa && !sb) return {}
  // If EITHER had a synthesized origin or the origins differ we
  // shouldn't have merged — canMerge guards above prevent that path,
  // so this is defensive.
  if (sa && sb && sa.origin !== sb.origin) return {}
  const origin = (sa?.origin ?? sb?.origin) as AtpSidecar['origin']
  if (origin === 'synthesized') return { _atp: { origin: 'synthesized' } }
  // Ghost sidecars do NOT carry a `source` and cannot be meaningfully
  // coalesced — ghosts represent a single live-layer block, not a
  // merge of upstream records. `canMerge` should prevent ghosts from
  // reaching this function, but if one does slip through we fall back
  // to "no sidecar on the merged entry" rather than inventing data.
  if (origin === 'ghost') return {}
  const flatten = (s: AtpSidecar | null): Array<ClaudeEntry | CodexRolloutLine> => {
    if (!s) return []
    if (s.origin === 'synthesized' || s.origin === 'ghost') return []
    return sidecarSources(s.source)
  }
  const sources = [...flatten(sa), ...flatten(sb)]
  if (origin === 'claude') {
    return { _atp: { origin, source: sources as ClaudeEntry[] } }
  }
  return { _atp: { origin, source: sources as CodexRolloutLine[] } }
}

function absorbClaudeSourceContext(ctx: Ctx, source: ClaudeEntry): void {
  // Sidecar short-circuit restores the original Claude entry byte-for-byte,
  // but the converter still keeps walking forward and may need to stamp later
  // non-sidecar entries. If we do not refresh the mutable context here, those
  // later stamped entries inherit stale session/cwd/git metadata from before
  // the short-circuited source, which creates mixed transcripts whose tail is
  // threaded against the wrong Claude session context.
  if (typeof source.sessionId === 'string' && source.sessionId.length > 0) {
    ctx.sessionId = source.sessionId
  }
  if (typeof source.cwd === 'string' && source.cwd.length > 0) {
    ctx.cwd = source.cwd
  }
  if (typeof source.gitBranch === 'string' && source.gitBranch.length > 0) {
    ctx.gitBranch = source.gitBranch
  }
  if (typeof source.version === 'string' && source.version.length > 0) {
    ctx.version = source.version
  }
  // The short-circuited source carries its own `message.id` (real
  // Anthropic-issued in most cases). Adopt it as the current turn id
  // when the source is an assistant entry with an id — then any
  // follow-on translated assistant emissions from the SAME turn still
  // merge with it. For non-assistant sources (user, attachment, etc.)
  // we clear the turn id so the next assistant allocates a fresh one.
  const sourceMid =
    source.type === 'assistant'
      ? (source.message as { id?: string } | undefined)?.id
      : undefined
  if (typeof sourceMid === 'string') {
    ctx.turnMessageId = sourceMid
  } else {
    resetTurnMessageId(ctx)
  }
}

// ---------------------------------------------------------------------------
// Per-line dispatcher
// ---------------------------------------------------------------------------

function mapLine(ctx: Ctx, line: CodexRolloutLine): ClaudeEntry[] {
  // atp_passthrough is a synthetic line type the toCodex side emits
  // for Claude entries with no native Codex equivalent (permission-
  // mode, file-history-snapshot, attachment, etc.). When the line
  // has a sidecar (fidelity mode), the short-circuit upstream
  // already restored the original Claude entry — we never reach
  // here. When there's no sidecar (lossy mode), the original is
  // genuinely lost and we drop the line silently. Same approach as
  // the unknown-type catch-all but more explicit.
  if (line.type === 'atp_passthrough') return []
  switch (line.type) {
    case 'session_meta': {
      mapSessionMeta(ctx, line.payload as CodexSessionMetaPayload)
      // Emit a sentinel system entry so the session_meta line has
      // somewhere to attach its sidecar. Without this, the line's
      // sidecar has no host and the Codex→Claude→Codex round-trip
      // loses the original session_meta bytes.
      return [
        stamp(ctx, {
          uuid: stableUuid([ctx.sessionId, ctx.index, line.timestamp, 'session_meta']),
          timestamp: line.timestamp,
          type: 'system',
          subtype: 'codex_session_meta',
        }),
      ]
    }
    case 'turn_context': {
      mapTurnContext(ctx, line.payload as CodexTurnContextPayload)
      return [
        stamp(ctx, {
          uuid: stableUuid([ctx.sessionId, ctx.index, line.timestamp, 'turn_context']),
          timestamp: line.timestamp,
          type: 'system',
          subtype: 'codex_turn_context',
        }),
      ]
    }
    case 'response_item':
      return mapResponseItem(
        ctx,
        line,
        line.payload as CodexResponseItemPayload,
      )
    case 'event_msg':
      return mapEventMsg(ctx, line, line.payload as CodexEventMsgPayload)
    case 'compacted':
      return mapCompacted(ctx, line)
    default:
      return mapUnknown(ctx, line)
  }
}

// ---------------------------------------------------------------------------
// Context-only mappers (no entries emitted)
// ---------------------------------------------------------------------------

function mapSessionMeta(ctx: Ctx, payload: CodexSessionMetaPayload): void {
  if (payload.id) ctx.sessionId = payload.id
  if (payload.cwd) ctx.cwd = payload.cwd
  if (payload.git?.branch) ctx.gitBranch = payload.git.branch
  if (payload.cli_version) ctx.version = payload.cli_version
  // New session: drop any turn id from whatever came before.
  resetTurnMessageId(ctx)
}

function mapTurnContext(ctx: Ctx, payload: CodexTurnContextPayload): void {
  if (payload.cwd) ctx.cwd = payload.cwd
  // turn_context is Codex's explicit "new turn starting" signal.
  // Force a fresh assistant id so the coming turn never merges with
  // whatever tool_use emissions accumulated in the previous one.
  resetTurnMessageId(ctx)
}

// ---------------------------------------------------------------------------
// response_item mappers
// ---------------------------------------------------------------------------

function mapResponseItem(
  ctx: Ctx,
  line: CodexRolloutLine,
  payload: CodexResponseItemPayload,
): ClaudeEntry[] {
  switch (payload.type) {
    case 'message':
      return mapMessage(ctx, line, payload as CodexMessagePayload)
    case 'function_call':
      return [mapFunctionCall(ctx, line, payload as CodexFunctionCallPayload)]
    case 'function_call_output':
      return [
        mapFunctionCallOutput(
          ctx,
          line,
          payload as CodexFunctionCallOutputPayload,
        ),
      ]
    case 'custom_tool_call':
      return [
        mapCustomToolCall(ctx, line, payload as CodexCustomToolCallPayload),
      ]
    case 'custom_tool_call_output':
      return mapCustomToolCallOutput(
        ctx,
        line,
        payload as CodexCustomToolCallOutputPayload,
      )
    case 'reasoning':
      return [mapReasoning(ctx, line, payload as CodexReasoningPayload)]
    case 'local_shell_call':
      return [
        mapLocalShellCall(ctx, line, payload as CodexLocalShellCallPayload),
      ]
    case 'web_search_call':
      return [mapWebSearchCall(ctx, line, payload as CodexWebSearchCallPayload)]
    case 'tool_search_call':
      return [mapToolSearchCall(ctx, line, payload as CodexToolSearchCallPayload)]
    case 'tool_search_output':
      return mapToolSearchOutput(ctx, line, payload as CodexToolSearchOutputPayload)
    default:
      return mapUnknown(ctx, line)
  }
}

function mapMessage(
  ctx: Ctx,
  line: CodexRolloutLine,
  payload: CodexMessagePayload,
): ClaudeEntry[] {
  const role: 'user' | 'assistant' =
    payload.role === 'user' ? 'user' : 'assistant'

  // Collect every text block into one Claude entry (matches Claude's
  // own JSONL: one entry per turn, multiple text blocks inside). If
  // the payload has no legible text content, skip it — the original
  // is preserved via sidecar for round-trip regardless.
  const blocks: ClaudeTextBlock[] = []
  for (const item of payload.content ?? []) {
    if (item.type === 'input_text' && typeof item.text === 'string') {
      blocks.push({ type: 'text', text: item.text })
    } else if (item.type === 'output_text' && typeof item.text === 'string') {
      blocks.push({ type: 'text', text: item.text })
    } else if (item.type === 'refusal' && typeof item.refusal === 'string') {
      blocks.push({ type: 'text', text: item.refusal })
    }
  }
  if (blocks.length === 0) return []

  // A user-text message marks a logical turn boundary — the next
  // assistant emission belongs to a new turn and needs a fresh id.
  // We reset BEFORE assembling the message so an assistant text
  // message emitted in the same stream (rare, but Codex can emit
  // developer/assistant messages right after a user prompt) picks up
  // the new id via currentTurnMessageId below.
  if (role === 'user') {
    resetTurnMessageId(ctx)
  }

  const message: ClaudeMessage = {
    role,
    content: blocks,
    ...(role === 'assistant'
      ? { id: currentTurnMessageId(ctx, line) }
      : payload.id
        ? { id: payload.id }
        : {}),
  }

  return [
    stamp(ctx, {
      uuid: stableUuid([ctx.sessionId, ctx.index, line.timestamp, 'message', role]),
      timestamp: line.timestamp,
      type: role,
      message,
    }),
  ]
}

function mapFunctionCall(
  ctx: Ctx,
  line: CodexRolloutLine,
  payload: CodexFunctionCallPayload,
): ClaudeEntry {
  const originalInput = parseToolInput(payload.arguments)
  const claudeToolName = mapToClaudeToolName(payload.name)
  const uuid = stableUuid([
    ctx.sessionId,
    ctx.index,
    line.timestamp,
    'function_call',
    payload.call_id,
  ])
  ctx.callInfo.set(payload.call_id, {
    assistantUuid: uuid,
    claudeToolName,
    originalToolName: payload.name,
    input: originalInput,
  })

  if (!claudeToolName) {
    return stamp(ctx, {
      uuid,
      timestamp: line.timestamp,
      type: 'assistant',
      message: {
        role: 'assistant',
        id: currentTurnMessageId(ctx, line),
        content: [
          {
            type: 'text',
            text: summarizeToolCall(payload.name, originalInput),
          },
        ],
      },
    })
  }

  const block: ClaudeToolUseBlock = {
    type: 'tool_use',
    id: payload.call_id,
    name: claudeToolName,
    input: claudeToolName === 'Bash' ? toBashInput(originalInput) : originalInput,
    ...(payload.namespace
      ? { codex: { namespace: payload.namespace } }
      : {}),
  }
  return stamp(ctx, {
    uuid,
    timestamp: line.timestamp,
    type: 'assistant',
    message: {
      role: 'assistant',
      id: currentTurnMessageId(ctx, line),
      content: [block],
    },
  })
}

function mapFunctionCallOutput(
  ctx: Ctx,
  line: CodexRolloutLine,
  payload: CodexFunctionCallOutputPayload,
): ClaudeEntry {
  // A tool_result ends one Claude assistant response. The next translated
  // assistant emission must allocate a fresh message.id so Claude does not
  // merge post-tool-result assistant chunks back into the pre-tool_result
  // assistant during resume normalization.
  resetTurnMessageId(ctx)
  const { text, metadata, richContent } = normalizeOutput(payload.output)
  const isError =
    metadata && typeof metadata.exit_code === 'number' && metadata.exit_code !== 0
  const callInfo = ctx.callInfo.get(payload.call_id)
  if (!callInfo?.claudeToolName) {
    return stamp(ctx, {
      uuid: stableUuid([
        ctx.sessionId,
        ctx.index,
        line.timestamp,
        'function_call_output_text',
        payload.call_id,
      ]),
      timestamp: line.timestamp,
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: summarizeToolResult(
              callInfo?.originalToolName ?? 'tool',
              text,
              Boolean(isError),
            ),
          },
        ],
      },
    })
  }

  const block: ClaudeToolResultBlock = {
    type: 'tool_result',
    tool_use_id: payload.call_id,
    // Prefer Claude-native rich tool_result content when Codex gave us
    // a structured array we can translate safely. This is especially
    // important for non-text outputs like documents/images, which
    // otherwise disappear into a plain-text summary even though Claude
    // can store them natively inside tool_result.content.
    //
    // We intentionally fall back to plain text for error results. Claude
    // enforces that `is_error` tool results contain only text content,
    // so preserving a richer array there would create a transcript that
    // looks fine locally but fails on the next resumed API call.
    content: isError ? text : richContent ?? text,
    ...(isError ? { is_error: true } : {}),
    ...(metadata ? { codex: { metadata } } : {}),
  }
  return stamp(ctx, {
    uuid: stableUuid([ctx.sessionId, ctx.index, line.timestamp, 'function_call_output', payload.call_id]),
    timestamp: line.timestamp,
    type: 'user',
    message: { role: 'user', content: [block] },
    sourceToolAssistantUUID: callInfo.assistantUuid,
    toolUseResult:
      callInfo.claudeToolName === 'Bash'
        ? toBashToolUseResult(payload.output, text)
        : undefined,
  })
}

function mapCustomToolCall(
  ctx: Ctx,
  line: CodexRolloutLine,
  payload: CodexCustomToolCallPayload,
): ClaudeEntry {
  const input = parseToolInput(payload.input)
  ctx.callInfo.set(payload.call_id, {
    assistantUuid: stableUuid([
      ctx.sessionId,
      ctx.index,
      line.timestamp,
      'custom_tool_call',
      payload.call_id,
    ]),
    originalToolName: payload.name,
    input,
  })
  return stamp(ctx, {
    uuid: stableUuid([ctx.sessionId, ctx.index, line.timestamp, 'custom_tool_call', payload.call_id]),
    timestamp: line.timestamp,
    type: 'assistant',
    message: {
      role: 'assistant',
      id: currentTurnMessageId(ctx, line),
      content: [
        {
          type: 'text',
          text: summarizeToolCall(payload.name, input),
        },
      ],
    },
  })
}

function mapCustomToolCallOutput(
  ctx: Ctx,
  line: CodexRolloutLine,
  payload: CodexCustomToolCallOutputPayload,
): ClaudeEntry[] {
  // Output from a custom tool is still a user-side turn boundary from
  // Claude's perspective; follow-on assistant text/tool calls must use a
  // fresh message.id.
  resetTurnMessageId(ctx)
  const { text, metadata, richContent } = normalizeOutput(payload.output)
  const isError =
    metadata && typeof metadata.exit_code === 'number' && metadata.exit_code !== 0
  const name = payload.name ?? ctx.callInfo.get(payload.call_id)?.originalToolName ?? 'tool'
  const out: ClaudeEntry[] = []

  if (richContent && richContent.length > 0) {
    // Custom tools do not have a clean Claude-native tool identity in our
    // translated sessions, so we cannot rely on a tool_result block the
    // same way we do for Bash. The next-best Claude-native construct for
    // machine-readable payloads is a structured_output attachment, which
    // Claude already persists for tools that return structured data.
    out.push(
      stamp(ctx, {
        uuid: stableUuid([
          ctx.sessionId,
          ctx.index,
          line.timestamp,
          'custom_tool_call_output_attachment',
          payload.call_id,
        ]),
        timestamp: line.timestamp,
        type: 'attachment',
        attachment: {
          type: 'structured_output',
          data: richContent,
        },
      }),
    )
  }

  out.push(
    stamp(ctx, {
      uuid: stableUuid([ctx.sessionId, ctx.index, line.timestamp, 'custom_tool_call_output', payload.call_id]),
      timestamp: line.timestamp,
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: summarizeToolResult(name, text, Boolean(isError)),
          },
        ],
      },
    }),
  )

  if (name === 'apply_patch' && !isError) {
    const files = extractApplyPatchFiles(ctx.callInfo.get(payload.call_id)?.input)
    for (const file of files) {
      out.push(
        stamp(ctx, {
          uuid: stableUuid([
            ctx.sessionId,
            ctx.index,
            line.timestamp,
            'apply_patch_attachment',
            file,
          ]),
          timestamp: line.timestamp,
          type: 'attachment',
          attachment: {
            type: 'edited_text_file',
            filename: file,
            snippet: 'Updated via translated Codex patch.',
          },
        }),
      )
    }
  }

  return out
}

function mapReasoning(
  ctx: Ctx,
  line: CodexRolloutLine,
  payload: CodexReasoningPayload,
): ClaudeEntry {
  const text = (payload.summary ?? [])
    .map(s => (typeof s.text === 'string' ? s.text : ''))
    .filter(Boolean)
    .join('\n\n')

  // Why NOT a `thinking` block:
  //
  // Claude's API requires every `thinking` block in assistant history to
  // carry a `signature` — an opaque server-generated token Anthropic
  // issues as cryptographic proof the thinking came from their
  // inference path. The API rejects with 400
  // ("messages.N.content.0.thinking.signature: Field required") when a
  // thinking block is sent back without one. Codex reasoning has NO
  // such signature and we cannot fabricate one, so emitting a
  // translator-synthesized `thinking` block poisons every downstream
  // resume.
  //
  // Claude's normalizer (utils/messages.ts filterTrailingThinkingFromLastAssistant,
  // filterOrphanedThinkingOnlyMessages) strips a few narrow cases but
  // does NOT blanket-remove unsigned thinking blocks mid-stream — so
  // we must not emit them in the first place.
  //
  // The chosen fallback is a plain text block, prefixed with a visible
  // "Reasoning:" marker so the renderer (and the model on next turn)
  // can still see the content but the API never inspects it as a
  // thinking block. Full round-trip fidelity is preserved via the
  // `_atp` sidecar on the containing entry — toCodex's sidecar
  // short-circuit restores the original `reasoning` payload byte-for-
  // byte. Lossy mode accepts the one-way conversion to text as the
  // cost of API safety.
  const block: ClaudeTextBlock = {
    type: 'text',
    text: text ? `Reasoning: ${text}` : 'Reasoning: (no summary provided)',
  }
  return stamp(ctx, {
    uuid: stableUuid([ctx.sessionId, ctx.index, line.timestamp, 'reasoning']),
    timestamp: line.timestamp,
    type: 'assistant',
    message: {
      role: 'assistant',
      id: currentTurnMessageId(ctx, line),
      content: [block],
    },
  })
}

function mapLocalShellCall(
  ctx: Ctx,
  line: CodexRolloutLine,
  payload: CodexLocalShellCallPayload,
): ClaudeEntry {
  // Codex has a first-class local_shell_call item, but Claude does not.
  // The closest native Claude surface is a Bash tool_use block.
  //
  // We normalize both the modern Codex wire shape (`command`,
  // `working_directory`) and our older fixture/debug shape (`cmd`,
  // `workdir`) because the translator has already accumulated both in
  // the wild. Being strict here would make the translator "correct"
  // against current source while regressing real transcripts we already
  // generated during investigation.
  const input =
    Array.isArray(payload.action?.command)
      ? {
          command: payload.action.command.join(' '),
          description: payload.action.command.join(' '),
          ...(typeof payload.action.working_directory === 'string'
            ? { workdir: payload.action.working_directory }
            : {}),
        }
      : payload.action?.cmd && Array.isArray(payload.action.cmd)
        ? {
            command: payload.action.cmd.join(' '),
            description: payload.action.cmd.join(' '),
            ...(typeof payload.action.workdir === 'string'
              ? { workdir: payload.action.workdir }
              : {}),
          }
        : payload.action
  const callId =
    payload.call_id ?? stableUuid([ctx.sessionId, ctx.index, 'local_shell_call'])
  ctx.callInfo.set(callId, {
    assistantUuid: stableUuid([ctx.sessionId, ctx.index, line.timestamp, 'local_shell_call']),
    claudeToolName: 'Bash',
    originalToolName: 'local_shell_call',
    input,
  })
  const block: ClaudeToolUseBlock = {
    type: 'tool_use',
    id: callId,
    name: 'Bash',
    input,
    codex: {
      kind: 'local_shell_call',
      ...(payload.status ? { status: payload.status } : {}),
    },
  }
  return stamp(ctx, {
    uuid: stableUuid([ctx.sessionId, ctx.index, line.timestamp, 'local_shell_call']),
    timestamp: line.timestamp,
    type: 'assistant',
    message: {
      role: 'assistant',
      id: currentTurnMessageId(ctx, line),
      content: [block],
    },
  })
}

function mapWebSearchCall(
  ctx: Ctx,
  line: CodexRolloutLine,
  payload: CodexWebSearchCallPayload,
): ClaudeEntry {
  const block: ClaudeToolUseBlock = {
    type: 'tool_use',
    id: stableUuid([ctx.sessionId, ctx.index, line.timestamp, 'web_search']),
    name: 'web_search',
    input: payload.action ?? {},
    codex: {
      kind: 'web_search_call',
      ...(payload.status ? { status: payload.status } : {}),
    },
  }
  return stamp(ctx, {
    uuid: stableUuid([ctx.sessionId, ctx.index, line.timestamp, 'web_search']),
    timestamp: line.timestamp,
    type: 'assistant',
    message: {
      role: 'assistant',
      id: currentTurnMessageId(ctx, line),
      content: [block],
    },
  })
}

function mapToolSearchCall(
  ctx: Ctx,
  line: CodexRolloutLine,
  payload: CodexToolSearchCallPayload,
): ClaudeEntry {
  const args = isRecord(payload.arguments) ? payload.arguments : {}
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  const limit =
    typeof args.limit === 'number' || typeof args.limit === 'string'
      ? String(args.limit)
      : undefined
  const details = [
    query ? `Query: ${query}` : null,
    limit ? `Limit: ${limit}` : null,
    payload.execution ? `Execution: ${payload.execution}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join('\n')

  // Codex persists tool-search discovery as first-class response items
  // because later turns can rely on that discovered tool inventory.
  // Claude has no equivalent search-tool transcript shape, so the
  // least-wrong lossy translation is a visible assistant summary that
  // records that discovery happened and what was searched for.
  return stamp(ctx, {
    uuid: stableUuid([
      ctx.sessionId,
      ctx.index,
      line.timestamp,
      'tool_search_call',
      payload.call_id ?? '',
    ]),
    timestamp: line.timestamp,
    type: 'assistant',
    message: {
      role: 'assistant',
      id: currentTurnMessageId(ctx, line),
      content: [
        {
          type: 'text',
          text: details
            ? `Searched available tools.\n${details}`
            : 'Searched available tools.',
        },
      ],
    },
  })
}

function mapToolSearchOutput(
  ctx: Ctx,
  line: CodexRolloutLine,
  payload: CodexToolSearchOutputPayload,
): ClaudeEntry[] {
  // Tool discovery output becomes a user-visible result turn in Claude.
  // Reset the current assistant message id so any later assistant summary
  // starts a fresh Claude response instead of merging backward.
  resetTurnMessageId(ctx)
  const tools = Array.isArray(payload.tools) ? payload.tools : []
  const names = tools
    .filter(isRecord)
    .map(tool => {
      const name = typeof tool.name === 'string' ? tool.name : ''
      const description = typeof tool.description === 'string' ? tool.description : ''
      return description ? `${name}: ${description}` : name
    })
    .filter(Boolean)
  const summaryParts = [
    `Tool search returned ${tools.length} result${tools.length === 1 ? '' : 's'}.`,
    payload.execution ? `Execution: ${payload.execution}.` : null,
    names.length > 0 ? `Top matches:\n${names.slice(0, 10).join('\n')}` : null,
  ].filter((part): part is string => part !== null)

  const out: ClaudeEntry[] = []

  // Claude does persist structured_output attachments even though they are
  // usually null-rendering in the UI. That makes them a good stash point for
  // the discovered tool inventory itself: the resumed model can still inspect
  // the raw tool list, while the human-visible transcript only shows a compact
  // summary instead of dumping every schema inline.
  if (tools.length > 0) {
    out.push(
      stamp(ctx, {
        uuid: stableUuid([
          ctx.sessionId,
          ctx.index,
          line.timestamp,
          'tool_search_output_attachment',
          payload.call_id ?? '',
        ]),
        timestamp: line.timestamp,
        type: 'attachment',
        attachment: {
          type: 'structured_output',
          data: tools,
        },
      }),
    )
  }

  out.push(
    stamp(ctx, {
      uuid: stableUuid([
        ctx.sessionId,
        ctx.index,
        line.timestamp,
        'tool_search_output',
        payload.call_id ?? '',
      ]),
      timestamp: line.timestamp,
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: summaryParts.join('\n\n'),
          },
        ],
      },
    }),
  )

  return out
}

// ---------------------------------------------------------------------------
// event_msg mappers
// ---------------------------------------------------------------------------

function mapEventMsg(
  ctx: Ctx,
  line: CodexRolloutLine,
  payload: CodexEventMsgPayload,
): ClaudeEntry[] {
  if (payload.type === 'thread_name_updated') {
    const title =
      typeof payload.thread_name === 'string' ? payload.thread_name.trim() : ''
    if (title.length > 0) {
      // Codex persists thread renames as a dedicated event, and Claude
      // persists the equivalent concept as a `custom-title` metadata
      // entry. Translating directly into Claude's metadata form is
      // better than a system sentinel because Claude's resume/tail
      // readers already know how to surface custom-title entries.
      return [
        stamp(ctx, {
          uuid: stableUuid([ctx.sessionId, ctx.index, line.timestamp, 'thread_name_updated']),
          timestamp: line.timestamp,
          type: 'custom-title',
          customTitle: title,
        }),
      ]
    }
  }
  if (payload.type === 'exec_approval_request') {
    const p = payload as {
      type: 'exec_approval_request'
      call_id: string
      command: string[]
      workdir?: string
    }
    const lines = [
      'Permission required before running a command.',
      p.command.length > 0 ? `Command: ${p.command.join(' ')}` : null,
      p.workdir ? `Directory: ${p.workdir}` : null,
    ]
      .filter((l): l is string => l !== null)
      .join('\n')
    const block: ClaudeTextBlock = { type: 'text', text: lines }
    return [
      stamp(ctx, {
        uuid: stableUuid([ctx.sessionId, ctx.index, line.timestamp, 'exec_approval', p.call_id]),
        timestamp: line.timestamp,
        type: 'assistant',
        message: {
          role: 'assistant',
          id: currentTurnMessageId(ctx, line),
          content: [block],
        },
      }),
    ]
  }
  // Other event_msg types (task_started, task_complete, token_count,
  // exec_command_begin/end, etc.) are render-only lifecycle signals
  // with no native Claude equivalent. Emit a sentinel system entry so
  // the line's sidecar has somewhere to attach — without this,
  // Codex→Claude→Codex would lose every event_msg in the original
  // stream. The renderer treats codex_event_msg as metadata noise and
  // doesn't display it.
  return [
    stamp(ctx, {
      uuid: stableUuid([ctx.sessionId, ctx.index, line.timestamp, 'event_msg', payload.type]),
      timestamp: line.timestamp,
      type: 'system',
      subtype: 'codex_event_msg',
    }),
  ]
}

// ---------------------------------------------------------------------------
// Other top-level types
// ---------------------------------------------------------------------------

/**
 * Codex's on-disk summary prefix. Kept in sync with
 * codex-src/codex-rs/core/templates/compact/summary_prefix.md. Codex
 * prepends this verbatim to the summary text inside
 * `CompactedItem.message`. We strip it here so the Claude-side
 * `isCompactSummary` user message carries just the informational
 * body, matching what `getCompactUserSummaryMessage` wraps its input
 * with natively.
 */
const CODEX_SUMMARY_PREFIX =
  'Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:'

/**
 * Mirror of Claude's `getCompactUserSummaryMessage` (claude-code-src/
 * full/services/compact/prompt.ts:337) with `suppressFollowUpQuestions`
 * and `transcriptPath` omitted — we don't have those at translate time.
 * The preamble is the load-bearing part: Claude's resume reads the
 * boundary fence and slices from there, so the immediate next user
 * message must look like a summary to the model. The preamble is what
 * makes it read as a handoff rather than a fresh prompt.
 */
function wrapClaudeCompactSummary(body: string): string {
  const trimmed = body.trim()
  return `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.

${trimmed}`
}

function mapCompacted(ctx: Ctx, line: CodexRolloutLine): ClaudeEntry[] {
  // A compact boundary restarts Codex's conversation — the assistant
  // messages on either side belong to different logical turns and must
  // not merge. Dropping the current turn id forces the next assistant
  // emission to allocate a fresh one.
  resetTurnMessageId(ctx)

  // Codex packs (fence + summary) into one rollout line. Claude writes
  // them as TWO adjacent entries: a `system {subtype:compact_boundary}`
  // fence followed by a `user {isCompactSummary:true}` summary (see
  // buildPostCompactMessages in claude-code-src/full/services/compact/
  // compact.ts). We must emit both so Claude's resume path
  // (`getMessagesAfterCompactBoundary` → slice → normalizeMessagesForAPI)
  // actually truncates pre-compact history and shows the summary as
  // the first post-boundary user message. Emitting only the fence
  // would leave Claude slicing to a void with no summary text —
  // the model would see nothing where the summary should be.
  const payload = line.payload as {
    message?: string
    replacement_history?: unknown
  }
  const rawMessage = typeof payload.message === 'string' ? payload.message : ''
  const innerSummary = rawMessage.startsWith(`${CODEX_SUMMARY_PREFIX}\n`)
    ? rawMessage.slice(CODEX_SUMMARY_PREFIX.length + 1)
    : rawMessage

  const boundaryUuid = stableUuid([
    ctx.sessionId,
    ctx.index,
    line.timestamp,
    'compacted',
  ])
  const summaryUuid = stableUuid([
    ctx.sessionId,
    ctx.index,
    line.timestamp,
    'compact_summary',
  ])

  const boundary = stamp(ctx, {
    uuid: boundaryUuid,
    timestamp: line.timestamp,
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    compactMetadata: line.payload,
  })

  // Override parentUuid on the summary to point at the boundary — stamp()
  // pulls ctx.parentUuid which still reflects whatever came before the
  // compacted line. Native Claude transcripts write the summary user
  // entry with parentUuid = boundary.uuid (createUserMessage + the
  // buildPostCompactMessages ordering), so matching that keeps the
  // chain well-formed for downstream consumers that walk parent links.
  const summary: ClaudeEntry = {
    ...stamp(ctx, {
      uuid: summaryUuid,
      timestamp: line.timestamp,
      type: 'user',
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: wrapClaudeCompactSummary(innerSummary),
          },
        ],
      },
    }),
    parentUuid: boundaryUuid,
  }

  return [boundary, summary]
}

function mapUnknown(ctx: Ctx, line: CodexRolloutLine): ClaudeEntry[] {
  // Forward-compat catch-all: emit a synthetic system entry so
  // round-trip via sidecar still works. No visible content — the
  // renderer will treat it as metadata noise.
  return [
    stamp(ctx, {
      uuid: stableUuid([ctx.sessionId, ctx.index, line.timestamp, 'codex_unknown', line.type]),
      timestamp: line.timestamp,
      type: 'system',
      subtype: 'codex_unknown',
    }),
  ]
}

// Re-export the content block types so toCodex (and external
// consumers) don't need to dual-import from types.ts.
export type { ClaudeContentBlock }

import type { StructuralFingerprint, StructuralShapeNode } from './types.js'

const MAX_DEPTH = 24
const MAX_NODES = 2_048

// WHY this allowlist is intentionally much smaller than the set of fields a
// translator cares about: structural catalogs are safe to retain only when a
// scalar is both low-cardinality and schema-defining. Fields such as `name`,
// `id`, `cwd`, `command`, and `text` can contain private project or user data.
// Their *types* remain visible, but their values never leave the profiler.
const SAFE_DISCRIMINATORS = new Set([
  'type',
  'kind',
  'subtype',
  'role',
  'phase',
  'status',
  'stop_reason',
])

// Values are allowlisted rather than accepted merely because they *look* like
// identifiers. A project codename or customer name can also look like a clean
// identifier, and `type` is still untrusted transcript data at this boundary.
const SAFE_DISCRIMINATOR_VALUES = new Set([
  'agent-name',
  'agent_message',
  'agent_reasoning',
  'assistant',
  'assistant_message',
  'atp_passthrough',
  'attachment',
  'away_summary',
  'ai-title',
  'api_error',
  'codex_event_msg',
  'codex_session_meta',
  'codex_turn_context',
  'collab_agent_interaction_end',
  'collab_agent_spawn_end',
  'collab_close_end',
  'collab_waiting_end',
  'compacted',
  'compact_boundary',
  'completed',
  'context_compacted',
  'custom-title',
  'custom_tool_call',
  'custom_tool_call_output',
  'developer',
  'document',
  'encrypted_content',
  'error',
  'event_msg',
  'exec',
  'exec_command_end',
  'failed',
  'fallback',
  'file-history-delta',
  'file-history-snapshot',
  'find_in_page',
  'frame-link',
  'function_call',
  'function_call_output',
  'image',
  'image_generation_call',
  'in_progress',
  'informational',
  'input_image',
  'input_text',
  'inter_agent_communication_metadata',
  'last-prompt',
  'local_shell_call',
  'local_shell_call_output',
  'local_command',
  'mcp_tool_call_end',
  'message',
  'mode',
  'model_consent_fallback',
  'model_refusal_fallback',
  'open_page',
  'other',
  'output_text',
  'patch_apply_end',
  'permission-mode',
  'pr-link',
  'progress',
  'queue-operation',
  'reasoning',
  'relocated',
  'result',
  'response_item',
  'scheduled_task_fire',
  'search',
  'session_meta',
  'started',
  'sub_agent_activity',
  'system',
  'task_complete',
  'task_started',
  'text',
  'thinking',
  'thread_goal_updated',
  'thread_name_updated',
  'thread_rolled_back',
  'thread_settings_applied',
  'token_count',
  'tool_result',
  'tool_search',
  'tool_search_call',
  'tool_search_output',
  'tool_use',
  'turn_aborted',
  'turn_context',
  'turn_duration',
  'user',
  'user_message',
  'web_search_end',
  'web_search_call',
  'worktree-state',
  'world_state',
])

export interface StructuralFingerprintOptions {
  maxDepth?: number
  maxNodes?: number
}

/**
 * Describe JSON structure without retaining arbitrary scalar values.
 *
 * Arrays are represented by the union of shapes found at each element rather
 * than by numeric indexes. Otherwise a long message-content array would mint a
 * different fingerprint solely because it contained three blocks instead of
 * two, which is frequency rather than structure. Object keys remain because
 * provider field names are the schema under investigation; unsafe/dynamic keys
 * are replaced with a type marker so a path or token used as a map key cannot
 * leak into the catalog.
 */
export function fingerprintJsonStructure(
  value: unknown,
  options: StructuralFingerprintOptions = {},
): StructuralFingerprint {
  const maxDepth = options.maxDepth ?? MAX_DEPTH
  const maxNodes = options.maxNodes ?? MAX_NODES
  const nodes: StructuralShapeNode[] = []
  let truncated = false

  function append(node: StructuralShapeNode): boolean {
    if (nodes.length >= maxNodes) {
      truncated = true
      return false
    }
    nodes.push(node)
    return true
  }

  function visit(current: unknown, path: string, depth: number, fieldName?: string): void {
    if (depth > maxDepth) {
      truncated = true
      return
    }

    const kind = jsonKind(current)
    const discriminator = safeStructuralDiscriminator(fieldName, current)
    if (!append({ path, kind, ...(discriminator ? { discriminator } : {}) })) return

    if (Array.isArray(current)) {
      // WHY dedupe child signatures before visiting: the catalog needs the union
      // of element forms, not one node per transcript block. The latter would
      // leak message length and make frequency explode the shape id.
      const representatives = new Map<string, unknown>()
      for (const item of current) {
        const signature = shallowKindSignature(item)
        if (!representatives.has(signature)) representatives.set(signature, item)
      }
      for (const [signature, item] of [...representatives].sort(([a], [b]) => a.localeCompare(b))) {
        visit(item, `${path}[]:${signature}`, depth + 1)
      }
      return
    }

    if (!isRecord(current)) return
    for (const [rawKey, child] of Object.entries(current).sort(([a], [b]) => a.localeCompare(b))) {
      const key = safeStructuralKey(rawKey) ? rawKey : `<dynamic-${jsonKind(child)}-key>`
      visit(child, `${path}.${key}`, depth + 1, rawKey)
    }
  }

  visit(value, '$', 0)
  nodes.sort(compareNodes)
  const canonical = nodes
    .map(node => `${node.path}\u0000${node.kind}\u0000${node.discriminator ?? ''}`)
    .join('\u0001')

  return {
    schemaVersion: 1,
    fingerprint: `shape-v1-${stableHash(canonical)}`,
    nodes,
    truncated,
  }
}

export function safeStructuralDiscriminator(
  fieldName: string | undefined,
  value: unknown,
): string | undefined {
  if (!fieldName || !SAFE_DISCRIMINATORS.has(fieldName)) return undefined
  if (typeof value !== 'string') return undefined
  return SAFE_DISCRIMINATOR_VALUES.has(value) ? value : '<other>'
}

function safeStructuralKey(key: string): boolean {
  // Provider schema keys are ordinary identifiers. Slashes, whitespace, long
  // tokens, dots from paths, and high-entropy map keys are collapsed because a
  // key can be user data just as easily as a value can.
  return /^[a-z_][a-z0-9_-]{0,63}$/i.test(key)
}

function shallowKindSignature(value: unknown): string {
  const kind = jsonKind(value)
  if (!isRecord(value)) return kind
  const discriminators = Object.entries(value)
    .filter(([key, child]) => safeStructuralDiscriminator(key, child) !== undefined)
    .map(([key, child]) => `${key}=${String(child)}`)
    .sort()
  return discriminators.length > 0 ? `${kind}(${discriminators.join(',')})` : kind
}

function jsonKind(value: unknown): StructuralShapeNode['kind'] {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'string') return 'string'
  return 'object'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function compareNodes(a: StructuralShapeNode, b: StructuralShapeNode): number {
  return a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind) ||
    (a.discriminator ?? '').localeCompare(b.discriminator ?? '')
}

/**
 * A small deterministic non-cryptographic hash keeps the pure v2 core usable in
 * browsers. Privacy does not rely on this hash: arbitrary scalar values were
 * already removed before canonicalization. Cryptographic source digests belong
 * in the Node-only fixture tooling instead.
 */
function stableHash(input: string): string {
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index)
    first ^= code
    first = Math.imul(first, 0x01000193)
    second ^= code + index
    second = Math.imul(second, 0x85ebca6b)
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0)
    .toString(16)
    .padStart(8, '0')}`
}

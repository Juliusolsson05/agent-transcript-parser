import type { RawJsonlDocument } from '../../jsonl/types.js'
import { isGhostRuntimeArtifact } from '../../runtimeArtifact.js'
import type { EvidenceClaim } from '../../evidence/claim.js'
import type {
  ClaudeClassificationResult,
  ClaudeClassifiedContentBlock,
  ClaudeClassifiedRecord,
  ClaudeMetadataRecord,
  ClaudeObservedRecordType,
  ClaudeObservedSystemSubtype,
} from './types.js'

const OBSERVED_METADATA_TYPES = new Set<ClaudeObservedRecordType>([
  'agent-name',
  'ai-title',
  'attachment',
  'file-history-delta',
  'file-history-snapshot',
  'frame-link',
  'last-prompt',
  'mode',
  'permission-mode',
  'pr-link',
  'queue-operation',
  'relocated',
  'result',
  'started',
  'worktree-state',
])

const OBSERVED_SYSTEM_SUBTYPES = new Set<ClaudeObservedSystemSubtype>([
  'api_error',
  'away_summary',
  'codex_event_msg',
  'codex_session_meta',
  'codex_turn_context',
  'compact_boundary',
  'informational',
  'local_command',
  'model_consent_fallback',
  'model_refusal_fallback',
  'scheduled_task_fire',
  'turn_duration',
])

const OBSERVED_BLOCK_TYPES = new Set([
  'text',
  'thinking',
  'tool_use',
  'tool_result',
  'image',
  'document',
  'fallback',
])

const CLAUDE_OBSERVATION_PROFILE = { provider: 'claude' as const }

/**
 * Classify Claude records exactly as observed without pretending this union is
 * an authoritative Claude schema. The checkout has no vendored Claude source,
 * so every known family carries an `observed-wire` claim and every unfamiliar
 * record remains opaque. Projection stages must not silently upgrade those
 * observations into a native-resume guarantee.
 */
export function classifyClaudeDocument(document: RawJsonlDocument): ClaudeClassificationResult {
  const records: ClaudeClassifiedRecord[] = []
  const skippedLines: ClaudeClassificationResult['skippedLines'] = []
  for (const line of document.lines) {
    if (line.kind !== 'record') {
      skippedLines.push({ line: line.index, kind: line.kind })
      continue
    }
    records.push(classifyClaudeRecord(line.value, line.index))
  }
  return { provider: 'claude', records, skippedLines }
}

export function classifyClaudeRecord(value: unknown, line = 0): ClaudeClassifiedRecord {
  if (!isRecord(value)) return opaque(value, line, null, ['Expected a JSON object.'])
  if (isGhostRuntimeArtifact(value)) {
    return opaque(value, line, typeof value.type === 'string' ? value.type : null, [
      'Provisional ghost record is outside durable transcript semantics.',
    ])
  }
  const type = typeof value.type === 'string' ? value.type : null
  const facts = type ? [`record:${type}`] : []
  const evidence = type ? [observed(`record:${type}`)] : []

  if (type === 'user' || type === 'assistant') {
    const message = isRecord(value.message) ? value.message : null
    const role = typeof message?.role === 'string' ? message.role : null
    if (role) facts.push(`message-role:${role}`)
    const blocks = classifyClaudeContent(message?.content)
    for (const block of blocks) {
      if (block.nativeType) facts.push(`message-block:${block.nativeType}`)
    }
    const diagnostics: string[] = []
    if (!message) diagnostics.push('Conversation record has no object message envelope.')
    if (role !== type) diagnostics.push(`Top-level type ${type} does not match message role ${role}.`)
    return {
      provider: 'claude',
      line,
      raw: value,
      family: type === 'user' ? 'user-message' : 'assistant-message',
      message,
      blocks,
      facts,
      evidence,
      diagnostics,
    }
  }

  if (type === 'system') {
    const rawSubtype = typeof value.subtype === 'string' ? value.subtype : null
    if (rawSubtype) facts.push(`subtype:${rawSubtype}`)
    const subtype = rawSubtype && OBSERVED_SYSTEM_SUBTYPES.has(rawSubtype as ClaudeObservedSystemSubtype)
      ? rawSubtype as ClaudeObservedSystemSubtype
      : 'unknown'
    return {
      provider: 'claude',
      line,
      raw: value,
      family: 'system',
      subtype,
      facts,
      evidence: [...evidence, ...(rawSubtype ? [observed(`subtype:${rawSubtype}`)] : [])],
      diagnostics: subtype === 'unknown' ? ['Uncatalogued Claude system subtype.'] : [],
    }
  }

  if (type && OBSERVED_METADATA_TYPES.has(type as ClaudeObservedRecordType)) {
    return {
      provider: 'claude',
      line,
      raw: value,
      family: 'metadata',
      recordType: type as ClaudeObservedRecordType,
      facts,
      evidence,
      diagnostics: [],
    } satisfies ClaudeMetadataRecord
  }

  return opaque(value, line, type, type ? ['Uncatalogued Claude record type.'] : ['Missing type.'])
}

function classifyClaudeContent(content: unknown): ClaudeClassifiedContentBlock[] {
  if (typeof content === 'string') {
    return [{
      family: 'text',
      index: 0,
      raw: content,
      nativeType: null,
      evidence: [observed('message-content:string')],
    }]
  }
  if (!Array.isArray(content)) return []
  return content.map((block, index) => {
    const nativeType = isRecord(block) && typeof block.type === 'string' ? block.type : null
    const family = nativeType && OBSERVED_BLOCK_TYPES.has(nativeType)
      ? nativeType as Exclude<ClaudeClassifiedContentBlock['family'], 'opaque'>
      : 'opaque'
    return {
      family,
      index,
      raw: block,
      nativeType,
      evidence: nativeType ? [observed(`message-block:${nativeType}`)] : [],
    }
  })
}

function opaque(
  value: unknown,
  line: number,
  nativeType: string | null,
  diagnostics: string[],
): ClaudeClassifiedRecord {
  return {
    provider: 'claude',
    line,
    raw: isRecord(value) ? value : { value },
    family: 'opaque',
    nativeType,
    facts: nativeType ? [`record:${nativeType}`] : [],
    evidence: nativeType ? [observed(`record:${nativeType}`)] : [],
    diagnostics,
  }
}

function observed(rule: string): EvidenceClaim {
  return { provenance: 'observed-wire', rule, profile: CLAUDE_OBSERVATION_PROFILE }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

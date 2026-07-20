import type { EvidenceClaim } from '../../evidence/claim.js'
import type { RawJsonlDocument } from '../../jsonl/types.js'
import type {
  CodexClassificationResult,
  CodexClassifiedRecord,
  CodexObservedExtensionType,
} from './types.js'

const CODEX_SOURCE_COMMIT = '8035cb03f1a5061d0342cb8fa3a10a18068ca683'
const SOURCE_PROFILE = { provider: 'codex' as const, sourceCommit: CODEX_SOURCE_COMMIT }
const OBSERVATION_PROFILE = { provider: 'codex' as const }
const EXTENSION_TYPES = new Set<CodexObservedExtensionType>([
  'atp_passthrough',
  'world_state',
  'inter_agent_communication_metadata',
])

/**
 * Classify the five native top-level RolloutItem families from pinned Codex
 * source separately from extensions merely observed in local rollout files.
 * This distinction is load-bearing: current Codex skips unknown top-level
 * lines, so `atp_passthrough` existing on disk is not evidence that Codex
 * reconstructs it as native conversation state.
 */
export function classifyCodexDocument(document: RawJsonlDocument): CodexClassificationResult {
  const records: CodexClassifiedRecord[] = []
  const skippedLines: CodexClassificationResult['skippedLines'] = []
  for (const line of document.lines) {
    if (line.kind !== 'record') {
      skippedLines.push({ line: line.index, kind: line.kind })
      continue
    }
    records.push(classifyCodexRecord(line.value, line.index))
  }
  return { provider: 'codex', records, skippedLines }
}

export function classifyCodexRecord(value: unknown, line = 0): CodexClassifiedRecord {
  if (!isRecord(value)) return opaque(value, line, null, ['Expected a JSON object.'])
  const type = typeof value.type === 'string' ? value.type : null
  const facts = type ? [`record:${type}`] : []
  const payload = isRecord(value.payload) ? value.payload : null
  const payloadType = typeof payload?.type === 'string' ? payload.type : null
  const payloadRole = typeof payload?.role === 'string' ? payload.role : null
  if (payloadType) facts.push(`payload:${payloadType}`)
  if (payloadRole) facts.push(`payload-role:${payloadRole}`)
  if (Array.isArray(payload?.content)) {
    for (const block of payload.content) {
      if (isRecord(block) && typeof block.type === 'string') {
        facts.push(`payload-block:${block.type}`)
      }
    }
  }
  if (isRecord(payload?.action) && typeof payload.action.type === 'string') {
    facts.push(`action:${payload.action.type}`)
  }

  const base = {
    provider: 'codex' as const,
    line,
    raw: value,
    facts,
    evidence: type ? [observed(`record:${type}`)] : [],
    diagnostics: [] as string[],
  }
  if (type === 'session_meta') {
    return {
      ...base,
      family: 'session-meta',
      payload,
      evidence: [...base.evidence, source('rollout-item:session_meta')],
      diagnostics: payload ? [] : ['session_meta has no object payload.'],
    }
  }
  if (type === 'response_item') {
    return {
      ...base,
      family: 'response-item',
      payload,
      itemType: payloadType,
      evidence: [...base.evidence, source('rollout-item:response_item')],
      diagnostics: payload ? [] : ['response_item has no object payload.'],
    }
  }
  if (type === 'event_msg') {
    return {
      ...base,
      family: 'event-message',
      payload,
      eventType: payloadType,
      evidence: [...base.evidence, source('rollout-item:event_msg')],
      diagnostics: payload ? [] : ['event_msg has no object payload.'],
    }
  }
  if (type === 'compacted') {
    return {
      ...base,
      family: 'compacted',
      payload,
      evidence: [...base.evidence, source('rollout-item:compacted')],
    }
  }
  if (type === 'turn_context') {
    return {
      ...base,
      family: 'turn-context',
      payload,
      evidence: [...base.evidence, source('rollout-item:turn_context')],
      diagnostics: payload ? [] : ['turn_context has no object payload.'],
    }
  }
  if (type && EXTENSION_TYPES.has(type as CodexObservedExtensionType)) {
    return {
      ...base,
      family: 'observed-extension',
      extensionType: type as CodexObservedExtensionType,
      diagnostics: ['Observed on disk but not a native RolloutItem in the pinned Codex source.'],
    }
  }
  return opaque(value, line, type, type ? ['Uncatalogued Codex record type.'] : ['Missing type.'])
}

function opaque(
  value: unknown,
  line: number,
  nativeType: string | null,
  diagnostics: string[],
): CodexClassifiedRecord {
  return {
    provider: 'codex',
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
  return { provenance: 'observed-wire', rule, profile: OBSERVATION_PROFILE }
}

function source(rule: string): EvidenceClaim {
  return { provenance: 'pinned-upstream-source', rule, profile: SOURCE_PROFILE }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

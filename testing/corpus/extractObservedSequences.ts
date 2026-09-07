import { createHash } from 'node:crypto'
import { readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import type { FixtureEvidenceManifest, TranscriptProvider } from '../../src/evidence/types.js'
import { redactObservedSequence } from './observedFixtures.js'

interface SequenceCandidate {
  caseId: string
  provider: TranscriptProvider
  feature: string
  records: unknown[]
  sourceDigest: string
  sourceBytes: number
}

export async function extractObservedSequences(options: {
  claudeRoot?: string
  codexRoot?: string
  outputDirectory: string
  reviewedAt?: string
}): Promise<{ cases: string[] }> {
  const candidates = new Map<string, SequenceCandidate>()
  if (options.claudeRoot) {
    await inspectRoot('claude', resolve(options.claudeRoot), candidates)
  }
  if (options.codexRoot) {
    await inspectRoot('codex', resolve(options.codexRoot), candidates)
  }
  if (candidates.size === 0) throw new Error('No observed sequence candidates found')

  const outputDirectory = resolve(options.outputDirectory)
  const reviewedAt = options.reviewedAt ?? new Date().toISOString()
  await mkdir(outputDirectory, { recursive: true })
  for (const candidate of [...candidates.values()].sort((a, b) => a.caseId.localeCompare(b.caseId))) {
    const directory = join(outputDirectory, candidate.caseId)
    await mkdir(directory, { recursive: true })
    const redacted = redactObservedSequence(candidate.records)
    await writeFile(
      join(directory, 'source.jsonl'),
      `${redacted.map(value => JSON.stringify(value)).join('\n')}\n`,
      'utf8',
    )
    const manifest: FixtureEvidenceManifest = {
      schemaVersion: 1,
      caseId: candidate.caseId,
      description: `Value-redacted observed sequence for ${candidate.feature}.`,
      provider: candidate.provider,
      format: 'jsonl',
      provenance: 'observed-wire',
      profile: { provider: candidate.provider, platform: 'darwin' },
      reviewedAt,
      normalization: [
        'Selected the smallest observed sequence satisfying the relationship.',
        'Kept only relationship-bearing records in original order.',
        'Pseudonymized scalar values while preserving identity equality across records.',
      ],
      redactions: ['All private scalar content, paths, URLs, timestamps, models, and identifiers.'],
      features: [candidate.feature],
      proves: ['wire-shape', 'classification'],
      doesNotProve: [
        'archive-fidelity',
        'native-discovery',
        'native-load',
        'native-reconstruction',
        'native-append',
        'semantic-translation',
        'agent-code-consumer',
      ],
      source: {
        kind: 'local-observation',
        sha256: candidate.sourceDigest,
        reference: 'local-corpus-census-2026-07-20',
      },
    }
    await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  }
  return { cases: [...candidates.keys()].sort() }
}

async function inspectRoot(
  provider: TranscriptProvider,
  root: string,
  candidates: Map<string, SequenceCandidate>,
): Promise<void> {
  for (const file of await collectJsonlFiles(root)) {
    const raw = await readFile(file.path, 'utf8')
    const records: unknown[] = []
    for (const line of raw.split(/\r?\n/)) {
      if (!line) continue
      try { records.push(JSON.parse(line)) } catch { /* malformed evidence is catalogued separately */ }
    }
    const sequences = [
      ...(provider === 'claude' ? claudeSequences(records) : codexSequences(records)),
      ...wholeRolloutSequences(provider, records),
    ]
    for (const sequence of sequences) {
      const serialized = sequence.records.map(value => JSON.stringify(value)).join('\n')
      const candidate: SequenceCandidate = {
        ...sequence,
        provider,
        sourceBytes: Buffer.byteLength(serialized),
        sourceDigest: createHash('sha256').update(serialized).digest('hex'),
      }
      const current = candidates.get(candidate.caseId)
      if (!current || candidate.sourceBytes < current.sourceBytes) {
        candidates.set(candidate.caseId, candidate)
      }
    }
  }
}

function claudeSequences(records: unknown[]): Array<Omit<SequenceCandidate, 'provider' | 'sourceBytes' | 'sourceDigest'>> {
  const results: Array<Omit<SequenceCandidate, 'provider' | 'sourceBytes' | 'sourceDigest'>> = []
  const toolUses = new Map<string, number>()
  const prompts: number[] = []
  let compactBoundary: number | undefined
  let compactSummary: number | undefined

  records.forEach((value, index) => {
    if (!isRecord(value)) return
    if (value.type === 'user' && value.isMeta !== true && value.isCompactSummary !== true) {
      prompts.push(index)
    }
    if (value.type === 'system' && value.subtype === 'compact_boundary' && compactBoundary === undefined) {
      compactBoundary = index
    }
    if (value.type === 'user' && value.isCompactSummary === true && compactSummary === undefined) {
      compactSummary = index
    }
    const content = isRecord(value.message) && Array.isArray(value.message.content)
      ? value.message.content
      : []
    for (const block of content) {
      if (!isRecord(block)) continue
      if (block.type === 'tool_use' && typeof block.id === 'string') toolUses.set(block.id, index)
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const callIndex = toolUses.get(block.tool_use_id)
        if (callIndex !== undefined && !results.some(result => result.caseId === 'claude-sequence-tool-cycle')) {
          const priorPrompt = [...prompts].reverse().find(prompt => prompt < callIndex)
          results.push({
            caseId: 'claude-sequence-tool-cycle',
            feature: 'sequence:tool-cycle',
            records: uniqueOrdered(records, [priorPrompt, callIndex, index]),
          })
        }
      }
    }
  })
  if (compactBoundary !== undefined && compactSummary !== undefined) {
    results.push({
      caseId: 'claude-sequence-compaction',
      feature: 'sequence:compaction',
      records: uniqueOrdered(records, [compactBoundary, compactSummary]),
    })
  }
  if (prompts.length >= 3) {
    results.push({
      caseId: 'claude-sequence-prompts',
      feature: 'sequence:prompt-addresses',
      records: uniqueOrdered(records, prompts.slice(0, 3)),
    })
  }
  return results
}

function codexSequences(records: unknown[]): Array<Omit<SequenceCandidate, 'provider' | 'sourceBytes' | 'sourceDigest'>> {
  const results: Array<Omit<SequenceCandidate, 'provider' | 'sourceBytes' | 'sourceDigest'>> = []
  const sessionMeta = records.findIndex(value => isRecord(value) && value.type === 'session_meta')
  const calls = new Map<string, number>()
  const prompts: number[] = []
  const duplicatePromptEvents: number[] = []
  let compacted: number | undefined
  let rollback: number | undefined

  records.forEach((value, index) => {
    if (!isRecord(value) || !isRecord(value.payload)) return
    const payload = value.payload
    if (value.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
      prompts.push(index)
    }
    if (value.type === 'event_msg' && payload.type === 'user_message') duplicatePromptEvents.push(index)
    if (value.type === 'compacted' && compacted === undefined) compacted = index
    if (value.type === 'event_msg' && payload.type === 'thread_rolled_back' && rollback === undefined) {
      rollback = index
    }
    if (
      value.type === 'response_item' &&
      ['function_call', 'custom_tool_call', 'local_shell_call'].includes(String(payload.type)) &&
      typeof payload.call_id === 'string'
    ) {
      calls.set(payload.call_id, index)
    }
    if (
      value.type === 'response_item' &&
      ['function_call_output', 'custom_tool_call_output', 'local_shell_call_output'].includes(String(payload.type)) &&
      typeof payload.call_id === 'string'
    ) {
      const callIndex = calls.get(payload.call_id)
      if (callIndex !== undefined && !results.some(result => result.caseId === 'codex-sequence-tool-cycle')) {
        results.push({
          caseId: 'codex-sequence-tool-cycle',
          feature: 'sequence:tool-cycle',
          records: uniqueOrdered(records, [sessionMeta, callIndex, index]),
        })
      }
    }
  })
  if (compacted !== undefined) {
    results.push({
      caseId: 'codex-sequence-compaction',
      feature: 'sequence:compaction',
      records: uniqueOrdered(records, [sessionMeta, compacted]),
    })
  }
  if (rollback !== undefined) {
    results.push({
      caseId: 'codex-sequence-rollback',
      feature: 'sequence:rollback',
      records: uniqueOrdered(records, [sessionMeta, rollback]),
    })
  }
  if (prompts.length >= 3) {
    results.push({
      caseId: 'codex-sequence-prompts',
      feature: 'sequence:prompt-addresses-and-duplicate-events',
      records: uniqueOrdered(records, [sessionMeta, ...prompts.slice(0, 3), ...duplicatePromptEvents.slice(0, 3)]),
    })
  }
  return results
}

/**
 * The subset of a rollout record the whole-rollout relationships read.
 *
 * WHY a declared shape rather than `Record<string, unknown>`: the predicates
 * below reach two levels down (`payload.rate_limits.rate_limit_reached_type`),
 * which `unknown` cannot express without a cast at every step. Every field
 * stays optional and `unknown`-valued because these are untrusted provider
 * records: the type documents what we *look at*, not what the provider
 * promises.
 */
interface SequenceRecord {
  type?: unknown
  isApiErrorMessage?: unknown
  error?: unknown
  /** Claude carries model-visible content here, Codex under `payload`. */
  message?: SequenceContentContainer | null
  payload?: SequencePayload | null
}

interface SequenceContentContainer {
  type?: unknown
  content?: unknown
  output?: unknown
  arguments?: unknown
}

interface SequencePayload extends SequenceContentContainer {
  rate_limits?: { rate_limit_reached_type?: unknown } | null
}

interface WholeRolloutRelationship {
  caseId: string
  provider: TranscriptProvider
  feature: string
  /** Does this file carry the relationship at all? Evaluated on every record. */
  select: (file: readonly SequenceRecord[]) => boolean
  /** Which records of that file are the evidence. Order is preserved. */
  keep: (record: SequenceRecord) => boolean
}

/**
 * Relationships whose evidence is the *proportions of a whole session*.
 *
 * WHY this is a second mechanism next to `claudeSequences`/`codexSequences`:
 * those cases pick two or three record indexes because their claim is local —
 * "a tool call is followed by its output", "a boundary is followed by its
 * carrier". The provider-switch ladder needs the opposite claim: how much of a
 * real session is pre-compaction history, tool output, or reasoning. A
 * two-record reduction answers nothing about that, so these cases keep every
 * semantic record and drop only envelope records that carry no conversation
 * content (Codex `event_msg` duplicates of prompts, Claude `summary` index
 * rows). Expressing them as a select/keep table keeps the predicate and the
 * retention rule adjacent, so a later reader can see what each fixture is
 * evidence *of* without re-reading the traversal.
 *
 * Selection across files is still smallest-first: `inspectRoot` keeps the
 * candidate with the fewest serialized bytes, so the corpus never grows by
 * more than the smallest real session that proves the relationship.
 */
const wholeRolloutRelationships: readonly WholeRolloutRelationship[] = [
  {
    caseId: 'codex-sequence-compacted-once',
    provider: 'codex',
    feature: 'sequence:compacted-rollout',
    // A rollout with exactly one `compacted` record: session_meta, every
    // response_item before it, the compacted record, and every response_item
    // after it. Kept whole because the shrink ladder must see real pre- and
    // post-compaction proportions, not a two-record reduction.
    select: file => countRecords(file, r => r.type === 'compacted') === 1,
    keep: r => r.type === 'session_meta' || r.type === 'response_item' || r.type === 'compacted' || r.type === 'turn_context',
  },
  {
    caseId: 'codex-sequence-compacted-multi',
    provider: 'codex',
    feature: 'sequence:repeatedly-compacted-rollout',
    select: file => countRecords(file, r => r.type === 'compacted') >= 3,
    keep: r => r.type === 'session_meta' || r.type === 'response_item' || r.type === 'compacted' || r.type === 'turn_context',
  },
  {
    caseId: 'codex-sequence-rate-limit-snapshot',
    provider: 'codex',
    feature: 'sequence:rate-limit-snapshot',
    select: file => file.some(r => r.type === 'event_msg' && r.payload?.type === 'token_count' && r.payload?.rate_limits?.rate_limit_reached_type != null),
    keep: r => r.type === 'session_meta' || (r.type === 'event_msg' && r.payload?.type === 'token_count'),
  },
  {
    caseId: 'claude-sequence-rate-limit',
    provider: 'claude',
    feature: 'sequence:rate-limit-error',
    select: file => file.some(r => r.type === 'assistant' && r.isApiErrorMessage === true && r.error === 'rate_limit'),
    // The user prompt before the error and the error itself, plus any
    // compact_boundary/isCompactSummary that follows: this is the #820 evidence.
    keep: r => r.type === 'user' || r.type === 'assistant' || r.type === 'system',
  },
  {
    caseId: 'claude-sequence-oversized',
    provider: 'claude',
    feature: 'sequence:oversized-history',
    // 581,400 characters is the configured Codex target budget (272k window at
    // 95 percent, 2.5 characters per token). A transcript above it is one the
    // shrink ladder must actually handle rather than pass through.
    select: file => estimateSemanticCharacters(file) > 581_400,
    keep: r => r.type === 'user' || r.type === 'assistant' || r.type === 'system',
  },
]

function wholeRolloutSequences(
  provider: TranscriptProvider,
  records: unknown[],
): Array<Omit<SequenceCandidate, 'provider' | 'sourceBytes' | 'sourceDigest'>> {
  const file = records.filter(isSequenceRecord)
  const results: Array<Omit<SequenceCandidate, 'provider' | 'sourceBytes' | 'sourceDigest'>> = []
  for (const relationship of wholeRolloutRelationships) {
    if (relationship.provider !== provider) continue
    if (!relationship.select(file)) continue
    const kept = file.filter(record => relationship.keep(record))
    if (kept.length === 0) continue
    results.push({ caseId: relationship.caseId, feature: relationship.feature, records: kept })
  }
  return results
}

function countRecords(
  file: readonly SequenceRecord[],
  predicate: (record: SequenceRecord) => boolean,
): number {
  return file.reduce((total, record) => (predicate(record) ? total + 1 : total), 0)
}

/**
 * Approximate the conversation characters `estimateConversationCharacters`
 * would report, without paying for classification and decoding of every local
 * transcript during extraction.
 *
 * WHY both `message` and `payload` are walked: the helper is named for a
 * neutral idea, and a reader who points it at a Codex rollout must not get a
 * silent zero. Only text actually sent to a model counts — prompt and reply
 * text, tool arguments, tool output — because that is what the shrink ladder
 * has to fit into a budget.
 */
function estimateSemanticCharacters(file: readonly SequenceRecord[]): number {
  let total = 0
  for (const record of file) {
    for (const container of [record.message, record.payload]) {
      if (!isRecord(container)) continue
      total += semanticCharactersOfContent(container.content)
      if (typeof container.output === 'string') total += container.output.length
      if (typeof container.arguments === 'string') total += container.arguments.length
    }
  }
  return total
}

function semanticCharactersOfContent(content: unknown): number {
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const block of content) {
    if (!isRecord(block)) continue
    if (typeof block.text === 'string') total += block.text.length
    if (block.type !== 'tool_result' && block.type !== 'function_call_output') continue
    const output = block.content ?? block.output
    if (typeof output === 'string') total += output.length
    else if (Array.isArray(output)) {
      for (const piece of output) {
        if (isRecord(piece) && typeof piece.text === 'string') total += piece.text.length
      }
    }
  }
  return total
}

function uniqueOrdered(records: unknown[], indexes: Array<number | undefined>): unknown[] {
  return [...new Set(indexes.filter((index): index is number => index !== undefined && index >= 0))]
    .sort((a, b) => a - b)
    .map(index => records[index])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// The same object test, narrowed to the shape the whole-rollout relationships
// read. Nothing is validated beyond object-ness on purpose: a record whose
// `payload` is a string simply fails every optional-chained predicate.
function isSequenceRecord(value: unknown): value is SequenceRecord {
  return isRecord(value)
}

async function collectJsonlFiles(root: string): Promise<Array<{ path: string; size: number }>> {
  const files: Array<{ path: string; size: number }> = []
  async function visit(directory: string): Promise<void> {
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const info = await stat(path)
        files.push({ path, size: info.size })
      }
    }
  }
  await visit(root)
  return files.sort((a, b) => a.size - b.size || a.path.localeCompare(b.path))
}

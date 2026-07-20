import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join, resolve } from 'node:path'

import { safeStructuralDiscriminator } from '../../src/v2/evidence/fingerprint.js'
import type {
  FixtureEvidenceManifest,
  TranscriptProvider,
} from '../../src/v2/evidence/types.js'

const MAX_REDACTION_DEPTH = 32
const MAX_ARRAY_SHAPES = 16
const PATH_FIELDS = new Set([
  'cwd',
  'path',
  'file_path',
  'filePath',
  'working_directory',
  'workdir',
])
const TIMESTAMP_FIELDS = new Set(['timestamp', 'created_at', 'updated_at', 'captured_at'])
const ID_FIELD = /(?:^|_)(?:id|uuid)$/i

export interface ObservedFixtureCandidate {
  caseId: string
  provider: TranscriptProvider
  feature: string
  rawLine: string
  rawBytes: number
}

export interface ExtractObservedFixturesOptions {
  claudeRoot?: string
  codexRoot?: string
  outputDirectory: string
  reviewedAt?: string
}

export interface ObservedFixtureCatalog {
  schemaVersion: 1
  generatedAt: string
  summary: {
    files: number
    bytes: number
    records: number
    malformedLines: number
    candidates: number
  }
  families: Array<{
    provider: TranscriptProvider
    caseId: string
    feature: string
    records: number
    files: number
  }>
}

interface FamilyAggregate {
  provider: TranscriptProvider
  caseId: string
  feature: string
  records: number
  files: Set<string>
  candidate?: ObservedFixtureCandidate
}

/**
 * Select the smallest real record for every reviewed schema discriminator and
 * produce a value-redacted candidate fixture. Selection happens on the raw
 * corpus, but only the redacted value and a one-way source digest are written.
 * Smallest-record selection is intentional: it retains the provider's actual
 * envelope while minimizing how much private source material ever enters the
 * redaction path.
 */
export async function extractObservedFixtureCandidates(
  options: ExtractObservedFixturesOptions,
): Promise<ObservedFixtureCatalog> {
  const inputs = [
    ...(options.claudeRoot
      ? [{ provider: 'claude' as const, root: resolve(options.claudeRoot) }]
      : []),
    ...(options.codexRoot
      ? [{ provider: 'codex' as const, root: resolve(options.codexRoot) }]
      : []),
  ]
  if (inputs.length === 0) throw new Error('At least one explicit corpus root is required')

  const outputDirectory = resolve(options.outputDirectory)
  const families = new Map<string, FamilyAggregate>()
  let files = 0
  let bytes = 0
  let records = 0
  let malformedLines = 0

  for (const input of inputs) {
    for (const file of await collectJsonlFiles(input.root)) {
      files += 1
      bytes += file.size
      const familiesSeenInFile = new Set<string>()
      const reader = createInterface({ input: createReadStream(file.path), crlfDelay: Infinity })
      for await (const line of reader) {
        if (line.trim().length === 0) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          malformedLines += 1
          continue
        }
        records += 1
        for (const descriptor of observedFamilyDescriptors(input.provider, parsed)) {
          const key = `${input.provider}\u0000${descriptor.caseId}`
          const aggregate = families.get(key) ?? {
            provider: input.provider,
            caseId: descriptor.caseId,
            feature: descriptor.feature,
            records: 0,
            files: new Set<string>(),
          }
          aggregate.records += 1
          if (!familiesSeenInFile.has(key)) {
            aggregate.files.add(file.path)
            familiesSeenInFile.add(key)
          }
          if (!aggregate.candidate || Buffer.byteLength(line) < aggregate.candidate.rawBytes) {
            aggregate.candidate = {
              caseId: descriptor.caseId,
              provider: input.provider,
              feature: descriptor.feature,
              rawLine: line,
              rawBytes: Buffer.byteLength(line),
            }
          }
          families.set(key, aggregate)
        }
      }
    }
  }

  await mkdir(outputDirectory, { recursive: true })
  const reviewedAt = options.reviewedAt ?? new Date().toISOString()
  for (const aggregate of [...families.values()].sort(compareFamilies)) {
    if (!aggregate.candidate) continue
    const parsed = JSON.parse(aggregate.candidate.rawLine) as unknown
    const redacted = redactObservedValue(parsed)
    const caseDirectory = join(outputDirectory, aggregate.caseId)
    await mkdir(caseDirectory, { recursive: true })
    await writeFile(join(caseDirectory, 'source.jsonl'), `${JSON.stringify(redacted)}\n`, 'utf8')

    const manifest: FixtureEvidenceManifest = {
      schemaVersion: 1,
      caseId: aggregate.caseId,
      description: `Value-redacted observation of ${aggregate.feature}.`,
      provider: aggregate.provider,
      format: 'jsonl',
      provenance: 'observed-wire',
      profile: { provider: aggregate.provider, platform: 'darwin' },
      reviewedAt,
      normalization: [
        'Selected the smallest observed record in the family.',
        'Pseudonymized scalar values while preserving reviewed schema discriminators.',
        'Deduplicated repeated array element structures.',
      ],
      redactions: [
        'Prompts, model output, commands, tool output, paths, URLs, ids, and timestamps.',
        'Unsafe or dynamic object keys.',
      ],
      features: [aggregate.feature],
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
        sha256: createHash('sha256').update(aggregate.candidate.rawLine).digest('hex'),
        reference: 'local-corpus-census-2026-07-20',
      },
    }
    await writeFile(join(caseDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  }

  const generatedAt = reviewedAt
  const catalog: ObservedFixtureCatalog = {
    schemaVersion: 1,
    generatedAt,
    summary: {
      files,
      bytes,
      records,
      malformedLines,
      candidates: [...families.values()].filter(value => value.candidate).length,
    },
    families: [...families.values()].sort(compareFamilies).map(value => ({
      provider: value.provider,
      caseId: value.caseId,
      feature: value.feature,
      records: value.records,
      files: value.files.size,
    })),
  }
  await writeFile(join(outputDirectory, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')
  return catalog
}

export function observedFamilyDescriptors(
  provider: TranscriptProvider,
  value: unknown,
): Array<{ caseId: string; feature: string }> {
  if (!isRecord(value)) return []
  const descriptors = new Map<string, { caseId: string; feature: string }>()
  function add(prefix: string, raw: unknown, featurePrefix: string): void {
    const discriminator = reviewedDiscriminator(raw)
    if (!discriminator) return
    const slug = discriminator.replace(/_/g, '-')
    const caseId = `${provider}-${prefix}-${slug}`
    descriptors.set(caseId, { caseId, feature: `${featurePrefix}:${discriminator}` })
  }

  add('record', value.type, 'record')
  add('subtype', value.subtype, 'subtype')

  if (isRecord(value.message)) {
    add('message-role', value.message.role, 'message-role')
    if (Array.isArray(value.message.content)) {
      for (const block of value.message.content) {
        if (isRecord(block)) add('message-block', block.type, 'message-block')
      }
    }
  }

  if (isRecord(value.payload)) {
    add('payload', value.payload.type, 'payload')
    add('payload-role', value.payload.role, 'payload-role')
    if (Array.isArray(value.payload.content)) {
      for (const block of value.payload.content) {
        if (isRecord(block)) add('payload-block', block.type, 'payload-block')
      }
    }
    if (isRecord(value.payload.action)) {
      add('action', value.payload.action.type, 'action')
    }
  }

  return [...descriptors.values()]
}

/**
 * Replace content while retaining the structural relationships a parser needs.
 * Equality among id-like strings is preserved through deterministic aliases so
 * a tool call/result pair can later be minimized as a sequence without losing
 * the edge that makes it useful.
 */
export function redactObservedValue(value: unknown): unknown {
  return createObservedRedactor()(value)
}

/** Preserve identity aliases across records while retaining every record. */
export function redactObservedSequence(values: readonly unknown[]): unknown[] {
  const redact = createObservedRedactor()
  return values.map(value => redact(value))
}

function createObservedRedactor(): (value: unknown) => unknown {
  const aliases = new Map<string, string>()
  let nextAlias = 1

  function redact(current: unknown, path: string[], depth: number): unknown {
    if (depth > MAX_REDACTION_DEPTH) return '<redacted-depth-limit>'
    if (current === null || typeof current === 'boolean') return current
    if (typeof current === 'number') return current === 0 ? 0 : current < 0 ? -1 : 1
    if (typeof current === 'string') {
      const field = path.at(-1) ?? ''
      const discriminator = safeStructuralDiscriminator(field, current)
      if (discriminator && discriminator !== '<other>') return discriminator
      if (TIMESTAMP_FIELDS.has(field) || /timestamp/i.test(field)) {
        return '2026-01-01T00:00:00.000Z'
      }
      if (PATH_FIELDS.has(field) || /(?:^|_)(?:path|cwd|directory|worktree)$/i.test(field)) {
        return '/fixture/project'
      }
      if (/url/i.test(field)) return 'https://example.invalid/fixture'
      if (ID_FIELD.test(field) || /(?:parent|session|request|call|turn).*id/i.test(field)) {
        const existing = aliases.get(current)
        if (existing) return existing
        const alias = `fixture-id-${nextAlias}`
        nextAlias += 1
        aliases.set(current, alias)
        return alias
      }
      if (/version/i.test(field)) return '0.0.0-fixture'
      if (/model/i.test(field)) return 'fixture-model'
      if (/name/i.test(field)) return 'FixtureName'
      if (/branch/i.test(field)) return 'fixture-branch'
      if (/hash|signature|token|encrypted|base64/i.test(field)) return '<redacted-data>'
      return 'fixture text'
    }
    if (Array.isArray(current)) {
      const representatives = new Map<string, unknown>()
      for (const item of current) {
        const key = structuralSelectionKey(item)
        if (!representatives.has(key)) representatives.set(key, item)
        if (representatives.size >= MAX_ARRAY_SHAPES) break
      }
      return [...representatives.values()].map((item, index) =>
        redact(item, [...path, String(index)], depth + 1),
      )
    }
    if (!isRecord(current)) return '<redacted-unsupported-value>'

    const result: Record<string, unknown> = {}
    let dynamicIndex = 1
    for (const [rawKey, child] of Object.entries(current).sort(([a], [b]) => a.localeCompare(b))) {
      const key = /^[a-z_][a-z0-9_-]{0,63}$/i.test(rawKey)
        ? rawKey
        : `dynamic_${jsonKind(child)}_key_${dynamicIndex++}`
      result[key] = redact(child, [...path, rawKey], depth + 1)
    }
    return result
  }

  return value => redact(value, [], 0)
}

function reviewedDiscriminator(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const discriminator = safeStructuralDiscriminator('type', value)
  return discriminator && discriminator !== '<other>' ? discriminator : undefined
}

function structuralSelectionKey(value: unknown): string {
  if (!isRecord(value)) return jsonKind(value)
  const type = reviewedDiscriminator(value.type)
  return `${jsonKind(value)}:${type ?? ''}:${Object.keys(value).sort().join(',')}`
}

function jsonKind(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function collectJsonlFiles(root: string): Promise<Array<{ path: string; size: number }>> {
  const files: Array<{ path: string; size: number }> = []
  async function visit(directory: string): Promise<void> {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
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
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

function compareFamilies(a: FamilyAggregate, b: FamilyAggregate): number {
  return a.provider.localeCompare(b.provider) || a.caseId.localeCompare(b.caseId)
}

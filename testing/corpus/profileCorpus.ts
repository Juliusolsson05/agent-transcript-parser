import { createReadStream } from 'node:fs'
import { mkdir, open, readdir, stat, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { dirname, relative, resolve, sep } from 'node:path'

import { fingerprintJsonStructure } from '../../src/v2/evidence/fingerprint.js'
import type {
  StructuralFingerprint,
  TranscriptProvider,
} from '../../src/v2/evidence/types.js'

export type CorpusCategory =
  | 'claude-main'
  | 'claude-subagent'
  | 'claude-nested'
  | 'codex-rollout'

export interface ProfileCorpusOptions {
  claudeRoot?: string
  codexRoot?: string
  outputPath: string
  generatedAt?: string
}

interface MutableShapeAggregate {
  provider: TranscriptProvider
  category: CorpusCategory
  fingerprint: StructuralFingerprint
  records: number
  files: Set<string>
}

interface MutableCategorySummary {
  provider: TranscriptProvider
  files: number
  bytes: number
  records: number
  blankLines: number
  malformedLines: number
  partialTailFiles: number
}

export interface CorpusProfile {
  schemaVersion: 1
  generatedAt: string
  privacy: {
    scalarValuesRetained: false
    filePathsRetained: false
    sessionIdsRetained: false
  }
  summary: {
    files: number
    bytes: number
    records: number
    blankLines: number
    malformedLines: number
    partialTailFiles: number
  }
  categories: Record<CorpusCategory, MutableCategorySummary>
  shapes: Array<{
    provider: TranscriptProvider
    category: CorpusCategory
    fingerprint: string
    records: number
    files: number
    truncated: boolean
    nodes: StructuralFingerprint['nodes']
  }>
}

/**
 * Profile local transcripts without retaining a path, id, prompt, command, or
 * output. This function is intentionally Node-only and lives under `testing/`:
 * local evidence acquisition is development tooling, not a capability the
 * published parser should gain.
 */
export async function profileCorpus(options: ProfileCorpusOptions): Promise<CorpusProfile> {
  const inputs = [
    ...(options.claudeRoot
      ? [{ provider: 'claude' as const, root: resolve(options.claudeRoot) }]
      : []),
    ...(options.codexRoot
      ? [{ provider: 'codex' as const, root: resolve(options.codexRoot) }]
      : []),
  ]
  if (inputs.length === 0) throw new Error('At least one explicit corpus root is required')

  const outputPath = resolve(options.outputPath)
  for (const input of inputs) {
    if (isInside(input.root, outputPath)) {
      throw new Error('Corpus output must not be written inside a provider transcript root')
    }
  }

  const categories = createCategorySummaries()
  const shapes = new Map<string, MutableShapeAggregate>()

  for (const input of inputs) {
    const files = await collectJsonlFiles(input.root)
    for (const file of files) {
      const category = categoryFor(input.provider, input.root, file.path)
      const summary = categories[category]
      summary.files += 1
      summary.bytes += file.size
      if (await hasPartialTail(file.path, file.size)) summary.partialTailFiles += 1

      const reader = createInterface({
        input: createReadStream(file.path),
        crlfDelay: Infinity,
      })
      for await (const line of reader) {
        if (line.trim().length === 0) {
          summary.blankLines += 1
          continue
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          summary.malformedLines += 1
          continue
        }

        summary.records += 1
        const fingerprint = fingerprintJsonStructure(parsed)
        const key = `${input.provider}\u0000${category}\u0000${fingerprint.fingerprint}`
        const aggregate = shapes.get(key) ?? {
          provider: input.provider,
          category,
          fingerprint,
          records: 0,
          files: new Set<string>(),
        }
        aggregate.records += 1
        // Paths exist only ephemerally in memory so we can report a cardinality.
        // They are discarded before the JSON artifact is assembled.
        aggregate.files.add(file.path)
        shapes.set(key, aggregate)
      }
    }
  }

  const categoryValues = Object.values(categories)
  const profile: CorpusProfile = {
    schemaVersion: 1,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    privacy: {
      scalarValuesRetained: false,
      filePathsRetained: false,
      sessionIdsRetained: false,
    },
    summary: {
      files: categoryValues.reduce((sum, value) => sum + value.files, 0),
      bytes: categoryValues.reduce((sum, value) => sum + value.bytes, 0),
      records: categoryValues.reduce((sum, value) => sum + value.records, 0),
      blankLines: categoryValues.reduce((sum, value) => sum + value.blankLines, 0),
      malformedLines: categoryValues.reduce((sum, value) => sum + value.malformedLines, 0),
      partialTailFiles: categoryValues.reduce((sum, value) => sum + value.partialTailFiles, 0),
    },
    categories,
    shapes: [...shapes.values()]
      .map(value => ({
        provider: value.provider,
        category: value.category,
        fingerprint: value.fingerprint.fingerprint,
        records: value.records,
        files: value.files.size,
        truncated: value.fingerprint.truncated,
        nodes: value.fingerprint.nodes,
      }))
      .sort((a, b) =>
        a.provider.localeCompare(b.provider) ||
        a.category.localeCompare(b.category) ||
        b.records - a.records ||
        a.fingerprint.localeCompare(b.fingerprint),
      ),
  }

  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(profile, null, 2)}\n`, 'utf8')
  return profile
}

function createCategorySummaries(): Record<CorpusCategory, MutableCategorySummary> {
  return {
    'claude-main': emptySummary('claude'),
    'claude-subagent': emptySummary('claude'),
    'claude-nested': emptySummary('claude'),
    'codex-rollout': emptySummary('codex'),
  }
}

function emptySummary(provider: TranscriptProvider): MutableCategorySummary {
  return {
    provider,
    files: 0,
    bytes: 0,
    records: 0,
    blankLines: 0,
    malformedLines: 0,
    partialTailFiles: 0,
  }
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
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(path)
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const info = await stat(path)
        files.push({ path, size: info.size })
      }
    }
  }
  await visit(root)
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

function categoryFor(
  provider: TranscriptProvider,
  root: string,
  filePath: string,
): CorpusCategory {
  if (provider === 'codex') return 'codex-rollout'
  const parts = relative(root, filePath).split(sep)
  if (parts.includes('subagents')) return 'claude-subagent'
  if (parts.length === 2) return 'claude-main'
  return 'claude-nested'
}

async function hasPartialTail(path: string, size: number): Promise<boolean> {
  if (size === 0) return false
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(1)
    await handle.read(buffer, 0, 1, size - 1)
    return buffer[0] !== 10
  } finally {
    await handle.close()
  }
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..')
}

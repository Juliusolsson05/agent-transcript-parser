import { readFile, readdir } from 'node:fs/promises'
import { extname, relative, resolve, sep } from 'node:path'

import { describe, expect, it } from 'vitest'

const v2Root = resolve(new URL('../../src/v2/', import.meta.url).pathname)

describe('v2 import boundaries', () => {
  it('keeps provider adapters isolated and the core browser-safe', async () => {
    const failures: string[] = []
    for (const file of await sourceFiles(v2Root)) {
      const source = await readFile(file, 'utf8')
      const path = relative(v2Root, file).split(sep).join('/')
      const imports = [...source.matchAll(/(?:from\s+|import\s*)['"]([^'"]+)['"]/g)]
        .map(match => match[1] ?? '')

      for (const specifier of imports) {
        if (
          specifier.startsWith('node:') ||
          specifier === 'fs' ||
          specifier === 'path' ||
          specifier.includes('electron')
        ) {
          failures.push(`${path} imports host-only module ${specifier}`)
        }
        if (specifier.includes('/ghost') || specifier.includes('agent-code')) {
          failures.push(`${path} crosses the frozen host/ghost boundary via ${specifier}`)
        }
        if (path.startsWith('claude/') && specifier.includes('/codex/')) {
          failures.push(`${path} imports Codex through ${specifier}`)
        }
        if (path.startsWith('codex/') && specifier.includes('/claude/')) {
          failures.push(`${path} imports Claude through ${specifier}`)
        }

        const isCompositionRoot = path === 'index.ts'
        const isProviderFile = path.startsWith('claude/') || path.startsWith('codex/')
        if (!isCompositionRoot && !isProviderFile && /\/(?:claude|codex)\//.test(specifier)) {
          failures.push(`${path} is provider-neutral but imports ${specifier}`)
        }
      }
    }

    expect(failures).toEqual([])
  })
})

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = []
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (extname(entry.name) === '.ts') files.push(path)
    }
  }
  await visit(root)
  return files.sort()
}

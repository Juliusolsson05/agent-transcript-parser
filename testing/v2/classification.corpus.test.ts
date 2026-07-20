import { readFile, readdir } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import { classifyClaudeRecord } from '../../src/v2/claude/classify/classify.js'
import { classifyCodexRecord } from '../../src/v2/codex/classify/classify.js'

const observedRoot = new URL('../../fixtures/v2/observed/', import.meta.url)

describe('v2 classification over observed wire families', () => {
  it('accounts for every manifest feature without silently dropping a record', async () => {
    const entries = (await readdir(observedRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))

    for (const entry of entries) {
      const directory = new URL(`${entry.name}/`, observedRoot)
      const manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8')) as {
        provider: 'claude' | 'codex'
        features: string[]
      }
      const source = await readFile(new URL('source.jsonl', directory), 'utf8')
      const record = JSON.parse(source)
      const classified = manifest.provider === 'claude'
        ? classifyClaudeRecord(record)
        : classifyCodexRecord(record)

      expect(classified.raw, entry.name).toEqual(record)
      for (const feature of manifest.features) {
        expect(classified.facts, `${entry.name} missing ${feature}`).toContain(feature)
      }
    }
  })
})

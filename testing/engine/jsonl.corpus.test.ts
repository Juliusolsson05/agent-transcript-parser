import { readFile, readdir } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import { decodeJsonl, encodeJsonlDocument } from '../../src/jsonl/codec.js'

const observedRoot = new URL('../../fixtures/evidence/observed/', import.meta.url)

describe('raw JSONL identity over observed wire fixtures', () => {
  it('round-trips every observed fixture without normalization', async () => {
    const entries = (await readdir(observedRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))
    expect(entries.length).toBeGreaterThanOrEqual(91)

    for (const entry of entries) {
      const source = await readFile(
        new URL(`${entry.name}/source.jsonl`, observedRoot),
        'utf8',
      )
      const document = decodeJsonl(source)
      expect(document.lines, entry.name).toHaveLength(1)
      expect(document.lines[0]?.kind, entry.name).toBe('record')
      expect(document.diagnostics, entry.name).toEqual([])
      expect(encodeJsonlDocument(document), entry.name).toBe(source)
    }
  })
})

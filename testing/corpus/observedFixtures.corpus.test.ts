import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { describe, expect, it } from 'vitest'

const fixtureRoot = new URL('../../fixtures/evidence/', import.meta.url)
const observedRoot = new URL('../../fixtures/evidence/observed/', import.meta.url)

describe('observed fixture corpus', () => {
  it('keeps every observed record adjacent to valid, bounded provenance', async () => {
    const schema = JSON.parse(
      await readFile(new URL('manifest.schema.json', fixtureRoot), 'utf8'),
    ) as object
    const ajv = new Ajv2020({ allErrors: true, strict: true })
    addFormats(ajv)
    const validate = ajv.compile(schema)
    const entries = (await readdir(observedRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))

    // WHY this is a lower bound rather than an exact count: the corpus is
    // intentionally ratcheted from reality. Adding an observed family should
    // not require changing a vanity count, while accidentally deleting most of
    // the evidence must fail loudly.
    expect(entries.length).toBeGreaterThanOrEqual(91)

    for (const entry of entries) {
      const directory = new URL(`${entry.name}/`, observedRoot)
      const manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8'))
      const source = await readFile(new URL('source.jsonl', directory), 'utf8')
      const lines = source.trimEnd().split('\n')

      expect(validate(manifest), `${entry.name}: ${ajv.errorsText(validate.errors)}`).toBe(true)
      expect(manifest.caseId).toBe(entry.name)
      expect(manifest.provenance).toBe('observed-wire')
      expect(manifest.proves).toEqual(['wire-shape', 'classification'])
      expect(lines).toHaveLength(1)
      expect(() => JSON.parse(lines[0] ?? '')).not.toThrow()
    }
  })

  it('contains no known private scalar or path patterns', async () => {
    const entries = (await readdir(observedRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
    const forbidden = [
      /\/Users\//,
      /juliusolsson/i,
      /Desktop\/Development/i,
      /BEGIN [A-Z ]*PRIVATE KEY/,
      /ghp_[A-Za-z0-9]{20,}/,
      /sk-[A-Za-z0-9]{20,}/,
      /https?:\/\/(?!example\.invalid)/,
    ]

    for (const entry of entries) {
      const source = await readFile(
        new URL(`${entry.name}/source.jsonl`, observedRoot),
        'utf8',
      )
      for (const pattern of forbidden) {
        expect(source, `${entry.name} matched ${String(pattern)}`).not.toMatch(pattern)
      }
    }
  })
})

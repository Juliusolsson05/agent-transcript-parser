import process from 'node:process'

import { extractObservedFixtureCandidates } from './observedFixtures.js'

const values = new Map<string, string>()
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]
  const value = process.argv[index + 1]
  if (!key?.startsWith('--') || !value) throw usage()
  values.set(key, value)
}

const outputDirectory = values.get('--out')
const claudeRoot = values.get('--claude-root')
const codexRoot = values.get('--codex-root')
if (!outputDirectory || (!claudeRoot && !codexRoot)) throw usage()

const catalog = await extractObservedFixtureCandidates({
  outputDirectory,
  ...(claudeRoot ? { claudeRoot } : {}),
  ...(codexRoot ? { codexRoot } : {}),
})

console.log(JSON.stringify({
  output: outputDirectory,
  ...catalog.summary,
}, null, 2))

function usage(): Error {
  return new Error(
    'Usage: tsx testing/corpus/extract-observed-fixtures.mts --claude-root <path> --codex-root <path> --out <ignored-path>',
  )
}

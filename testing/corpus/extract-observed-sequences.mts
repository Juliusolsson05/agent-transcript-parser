import process from 'node:process'

import { extractObservedSequences } from './extractObservedSequences.js'

const values = new Map<string, string>()
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index]
  const value = process.argv[index + 1]
  if (!key?.startsWith('--') || !value) throw new Error('Invalid arguments')
  values.set(key, value)
}
const outputDirectory = values.get('--out')
if (!outputDirectory) throw new Error('--out is required')
const result = await extractObservedSequences({
  outputDirectory,
  ...(values.get('--claude-root') ? { claudeRoot: values.get('--claude-root') } : {}),
  ...(values.get('--codex-root') ? { codexRoot: values.get('--codex-root') } : {}),
})
console.log(JSON.stringify(result, null, 2))

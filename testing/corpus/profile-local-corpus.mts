import process from 'node:process'

import { profileCorpus } from './profileCorpus.js'

const args = parseArgs(process.argv.slice(2))
const profile = await profileCorpus(args)

// WHY stdout contains only aggregate counts: terminal scrollback is often
// copied into issues and debug bundles. Even though the persisted profile is
// structural-only, echoing roots or samples here would create a second privacy
// surface that is easy to overlook.
console.log(JSON.stringify({
  output: args.outputPath,
  files: profile.summary.files,
  records: profile.summary.records,
  bytes: profile.summary.bytes,
  shapes: profile.shapes.length,
  malformedLines: profile.summary.malformedLines,
  partialTailFiles: profile.summary.partialTailFiles,
}, null, 2))

function parseArgs(argv: string[]): {
  claudeRoot?: string
  codexRoot?: string
  outputPath: string
} {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || !value) throw usage()
    values.set(key, value)
  }
  const outputPath = values.get('--out')
  const claudeRoot = values.get('--claude-root')
  const codexRoot = values.get('--codex-root')
  if (!outputPath || (!claudeRoot && !codexRoot)) throw usage()
  return {
    outputPath,
    ...(claudeRoot ? { claudeRoot } : {}),
    ...(codexRoot ? { codexRoot } : {}),
  }
}

function usage(): Error {
  return new Error(
    'Usage: tsx testing/corpus/profile-local-corpus.mts --claude-root <path> --codex-root <path> --out <ignored-path>',
  )
}

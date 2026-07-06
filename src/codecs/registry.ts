// Codec registry: adding provider N+1 = registering one entry.
//
// The pairwise `toClaude`/`toCodex` API (kept intact in index.ts as
// thin wrappers over the codecs once the semantic surface catches up
// with what those functions understand) will be reimplemented in a
// follow-up PR as `encode(target, decode(source))` on top of this
// registry. Until then, this file is the seam consumers use to sniff
// a file, choose a codec, and drive lossless decode/encode.

import type { AgentProviderId, Codec } from '../neutral/types.js'
import { ClaudeCodec } from './claude.js'
import { CodexCodec } from './codex.js'

const registry: Record<AgentProviderId, Codec<unknown>> = {
  claude: ClaudeCodec as Codec<unknown>,
  codex: CodexCodec as Codec<unknown>,
}

export function getCodec(id: AgentProviderId): Codec<unknown> {
  return registry[id]
}

/**
 * Sniff a JSONL file's first record and return the matching codec.
 * Order-sensitive: Codex's sniff (`payload` present) is tried FIRST
 * to match the historical ordering of `detectFormat`, which classifies
 * a record with both `payload` and `uuid` as codex.
 */
export function sniffCodec(firstRecord: unknown): Codec<unknown> | null {
  if (CodexCodec.sniff(firstRecord)) return CodexCodec as Codec<unknown>
  if (ClaudeCodec.sniff(firstRecord)) return ClaudeCodec as Codec<unknown>
  return null
}

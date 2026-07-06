// Cross-provider translation over the neutral hub (#5, slice 2).
//
// THE STRATEGY (read this before "simplifying"): the public shape is
// A↔C↔B — consumers hand a NeutralTranscript to a target codec and
// get target-format lines plus a report. But the translation ENGINE
// inside is, for now, the battle-tested pairwise converters
// (toClaude/toCodex, ~3.5k lines of provider-quirk knowledge with
// their own round-trip suite). Decode is lossless by construction
// (every source line rides the passthrough region), so we can
// RECONSTRUCT the original source stream exactly and feed it to the
// legacy engine — making
//
//   ClaudeCodec.encode(CodexCodec.decode(x)) ≡ toClaude(x)
//
// hold byte-for-byte from day one (proven by
// testing/translate-equivalence.ts). Consumers get the stable hub API
// now; later slices migrate the engine to true per-entry neutral
// translation underneath, verified against the same corpus, without
// consumers noticing. This is the strangler-fig seam, not the final
// engine.
//
// WHY reconstruction is sound: decode maps source lines 1:1 into
// entries IN ORDER, each carrying its line in raw.records. Flattening
// entries' records in entry order therefore reproduces the source
// array exactly (asserted cheaply below — if a future decode starts
// coalescing N:M without updating this seam, translation fails loudly
// instead of silently dropping lines).

import { toClaude } from '../toClaude.js'
import { toCodex } from '../toCodex.js'
import type { ConvertOptions } from '../toClaude.js'
import type { ClaudeEntry, CodexRolloutLine } from '../types.js'
import type {
  AgentProviderId,
  CodecReport,
  NeutralTranscript,
} from './types.js'
import { EMPTY_REPORT } from './types.js'

export type TranslateResult<T> = {
  lines: T[]
  report: CodecReport
}

/**
 * Reconstruct the original provider lines from a neutral transcript's
 * passthrough regions. Throws if the transcript mixes providers or
 * lacks passthrough — both would mean the transcript didn't come from
 * a codec decode, and translating a hand-built neutral transcript is
 * exactly the future-engine work this seam does NOT claim to do yet.
 */
export function reconstructSource(
  neutral: NeutralTranscript,
): { provider: AgentProviderId; records: unknown[] } {
  let provider: AgentProviderId | null = null
  const records: unknown[] = []
  for (const entry of neutral.entries) {
    if (!entry.raw || entry.raw.records.length === 0) {
      throw new Error(
        'translate: neutral entry without passthrough — hand-built neutral transcripts are not translatable yet (engine migration pending, see #5)',
      )
    }
    if (provider === null) provider = entry.raw.provider
    if (entry.raw.provider !== provider) {
      throw new Error(
        `translate: mixed-provider neutral transcript (${provider} + ${entry.raw.provider})`,
      )
    }
    records.push(...entry.raw.records)
  }
  if (provider === null) {
    throw new Error('translate: empty neutral transcript')
  }
  return { provider, records }
}

/**
 * Translate a decoded neutral transcript into the target provider's
 * wire format. Same-provider targets re-emit passthrough verbatim
 * (identity — the codecs' own encode path). Cross-provider targets
 * run the legacy engine over the reconstructed source.
 *
 * The report is engine-level for now: the legacy converters preserve
 * unmappable content via _atp sidecars in fidelity mode rather than
 * dropping it, so `dropped` stays empty and lossy-mode drops are the
 * caller's explicit opt-in. Per-entry drop accounting arrives with
 * the neutral engine migration.
 */
export function translateToClaude(
  neutral: NeutralTranscript,
  opts: ConvertOptions = {},
): TranslateResult<ClaudeEntry> {
  const source = reconstructSource(neutral)
  if (source.provider === 'claude') {
    return { lines: source.records as ClaudeEntry[], report: EMPTY_REPORT }
  }
  return {
    lines: toClaude(source.records as CodexRolloutLine[], opts),
    report: EMPTY_REPORT,
  }
}

export function translateToCodex(
  neutral: NeutralTranscript,
  opts: ConvertOptions = {},
): TranslateResult<CodexRolloutLine> {
  const source = reconstructSource(neutral)
  if (source.provider === 'codex') {
    return { lines: source.records as CodexRolloutLine[], report: EMPTY_REPORT }
  }
  return {
    lines: toCodex(source.records as ClaudeEntry[], opts),
    report: EMPTY_REPORT,
  }
}

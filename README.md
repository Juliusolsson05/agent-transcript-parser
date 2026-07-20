# agent-transcript-parser

An evidence-driven transcript engine for agent providers.

The package converts each provider into a shared conversation document and
projects that document into any registered provider. It does not contain a
Claude-to-Codex translator or a Codex-to-Claude translator:

```text
Claude ─┐
Codex  ─┼─> ConversationDocument ─> Claude / Codex / future provider
Future ─┘
```

That hub shape is the main architectural contract. Supporting another provider
requires one decoder plus that provider's output projectors; it does not require
pairwise translators to every provider already supported.

## Profiles

Archive and native resume are intentionally different APIs:

- `projectArchive` favors preservation. Unknown records can survive as bounded,
  non-recursive provenance.
- `projectNativeResume` emits only the provider-native subset supported by a
  named evidence profile. Unsupported data is dropped or repaired and reported.

Every projection returns a structured report describing preservation, loss,
demotion, repair, synthesis, and identity changes. A green archive test is not a
claim that a provider CLI can resume the result.

## Basic use

```ts
import {
  classifyClaudeDocument,
  codexNativeResumeProjector,
  decodeClaudeConversation,
  decodeJsonl,
} from 'agent-transcript-parser'

const raw = decodeJsonl(sourceText)
const classified = classifyClaudeDocument(raw)
const conversation = decodeClaudeConversation(classified.records)
const projected = codexNativeResumeProjector.projectNativeResume(conversation, {
  targetSessionId: crypto.randomUUID(),
  now: new Date().toISOString(),
  cwd: '/project',
  cliVersion: '0.144.6',
  modelProvider: 'openai',
  model: 'gpt-5',
})

console.log(projected.values)
console.log(projected.report)
```

## Stable clone and rewind

Analysis returns prompt addresses tied to provider-native source lines. Pass the
same address object into `rewindConversation` or `rewindForNativeResume`; never
reconstruct an index from a filtered UI list.

```ts
const analysis = analyzeCodexTranscript(records)
const address = analysis.prompts.at(-1)?.address
if (address) {
  const rewind = rewindForNativeResume(
    conversation,
    address,
    codexNativeResumeProjector,
    options,
  )
}
```

## Evidence and unknown data

Checked-in fixtures under `fixtures/evidence/` are privacy-reviewed, value-redacted
structural reductions of observed transcripts. Each fixture carries a manifest
that states what it proves and what it does not prove. Codex native-resume rules
are also tied to a pinned upstream source commit; Claude native-resume support is
explicitly observation-scoped.

Unknown JSONL remains opaque. It is never guessed into plausible assistant
speech. Archive provenance is byte-bounded and strips prior provenance fields
to prevent recursive growth.

## Ghost records

The frozen provisional-render ledger remains available only through the explicit
subpath:

```ts
import {
  createGhost,
  reduceGhostLog,
  mergeWithUpstream,
} from 'agent-transcript-parser/ghost'
```

Ghost records are runtime artifacts, not durable conversation semantics. The
decoders recognize valid ghost markers without importing ghost implementation
and exclude them from archive and native-resume projection. See
[`docs/ghost.md`](./docs/ghost.md) for the frozen lifecycle contract.

## Development

```bash
npm install
npm run check
npm run corpus:profile -- --claude-root <path> --codex-root <path> --out <ignored-path>
```

The profiler is read-only and requires explicit roots and output. Raw personal
transcripts are never committed.

Requires Node 20.19 or newer. ESM only.

## Layout

```text
src/                    evidence-driven engine
  claude/               Claude classifier, analysis, decoder, projectors
  codex/                Codex classifier, analysis, decoder, projectors
  conversation/         provider-neutral protocol
  operations/           stable addresses, clone, rewind
  projection/           shared projection contracts and provenance
  report/               explicit change reports
  ghost.ts              frozen ghost lifecycle
  ghost-sidecar.ts      minimal ghost-only wire vocabulary
fixtures/evidence/      reviewed evidence fixtures and manifests
testing/engine/         unit and corpus contracts
testing/corpus/         privacy-safe extraction and profiling tools
```

## License

MIT

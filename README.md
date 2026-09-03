# agent-transcript-parser

An evidence-driven transcript engine for agent providers.

The package converts each provider into a shared conversation document and
projects that document into any registered provider. It does not contain a
Claude-to-Codex translator or a Codex-to-Claude translator:

```text
Claude ─┐
Codex  ─┼─> ConversationDocument ─> Claude / Codex / OpenCode / future provider
OpenCode┤
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
  model: configuredModelId,
})

console.log(projected.values)
console.log(projected.report)
```

## Context and compaction planning

The parser owns decisions that can be derived from a `ConversationDocument`;
the host application owns live process I/O, clocks, cancellation, and UI. Use
the typed plan rather than rebuilding compaction rules from loose booleans:

```ts
import {
  budgetCharactersForContextTokens,
  planConversationContext,
} from 'agent-transcript-parser'

const budget = budgetCharactersForContextTokens(200_000, {
  effectiveContextPercent: 90,
})
const plan = planConversationContext(conversation, 'claude', budget)

switch (plan.kind) {
  case 'ready':
  case 'existing-compaction':
    await project(plan.conversation)
    break
  case 'requires-compaction':
    await requestNativeCompaction()
    break
  case 'requires-portable-handoff':
    await requestPlaintextHandoffFromSourceProvider()
    break
}
```

`requires-portable-handoff` is distinct from `requires-compaction`: current
Codex compaction is durable but provider-encrypted, so another provider needs a
read-only plaintext handoff turn. Claude compaction is portable only after its
`isCompactSummary` carrier arrives; the preceding `Conversation compacted`
boundary is intentionally classified as incomplete. OpenCode exports do not
expose a portable native compaction payload, so an oversized OpenCode source
also requires a read-only plaintext handoff from the live provider.

## OpenCode import and export

OpenCode uses one JSON export envelope rather than a JSONL transcript. Decode
that supported CLI shape directly, then project a neutral conversation into a
single value suitable for `opencode import`:

```ts
import {
  decodeOpencodeConversation,
  opencodeNativeResumeProjector,
} from 'agent-transcript-parser'

const conversation = decodeOpencodeConversation(exportedJson)
const projected = opencodeNativeResumeProjector.projectNativeResume(conversation, {
  targetSessionId: crypto.randomUUID(),
  now: new Date().toISOString(),
  cwd: '/project',
  cliVersion: '1.18.27',
  modelProvider: 'anthropic',
  model: 'claude-sonnet-4',
})

console.log(projected.values[0])
```

The package never opens OpenCode's private SQLite database or executes its CLI.
The host owns export/import execution and temporary-file security; the parser
owns pure decoding, deterministic native identities, and fidelity reporting.

`fitConversationToCharacterBudget` remains an explicit lossy escape hatch. Its
result includes `stillExceedsBudget`; callers must not assume that a complete
turn boundary small enough to satisfy an arbitrary budget always exists.

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

### Real translated-resume probe

The structural and native-load tests intentionally avoid paid model turns, so
they cannot prove that a translated session accepts a prompt and produces a
reply. From this package inside an Agent Code checkout, run the opt-in probe
against one transcript or a directory of JSONL transcripts:

```bash
npm run probe:live-resume -- --input ~/.codex/sessions/path/to/rollout.jsonl
npm run probe:live-resume -- --input ./private-corpus --target both --max-files 10
```

The probe imports only the sibling `codex-headless` and `claude-code-headless`
packages, projects each input into a unique native session, resumes the real
installed CLI in a throwaway read-only workspace, submits a no-tools summary
prompt, and requires a newly committed assistant response. Cases run
sequentially because every case makes a real provider request. Projected files
and any resume forks are removed by default; pass `--keep` to retain a failed
case for manual diagnosis.

Inside an Agent Code checkout, run `npm run typecheck:probe` to type-check the
optional harness against the sibling headless packages. The standalone package
gate excludes that host-only harness, and the published `dist/` remains free of
headless or Agent Code dependencies.

Requires Node 20.19 or newer. ESM only.

## Layout

```text
src/                    evidence-driven engine
  claude/               Claude classifier, analysis, decoder, projectors
  codex/                Codex classifier, analysis, decoder, projectors
  opencode/             OpenCode export decoder and native resume projector
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

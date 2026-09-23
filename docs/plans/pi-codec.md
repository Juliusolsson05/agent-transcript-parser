# Pi Conversation Codec

Part of Agent Code #1132 (Pi as a terminal-only provider), Stage 10 of
`docs/superpowers/plans/2026-09-22-pi-terminal-harness.md` in the app. Branch
`feat/pi-codec`. No merge or release is authorized by this plan.

## Contract

Add Pi (`@earendil-works/pi-coding-agent` 0.87.1, source
earendil-works/pi@96724621) as one decoder plus one archive projector and one
native-resume projector. It goes through the existing provider-neutral document,
the same archive/native-resume contracts and the same loss reports. No pairwise
converters. No import of `pi-terminal-headless`: the parser stays browser-safe
and I/O-free, so the few Pi session rules it needs are restated here from the
pinned source, not shared with the runtime package.

### Decoder: the conversation Pi itself would send

A Pi session file is a TREE (`id`/`parentId`), not a list. `/tree` and forks
leave abandoned turns in the same file. The neutral document is a linear
conversation. So the decoder decodes exactly what Pi's
`buildSessionContext` sends to the model:

1. Active branch = the parentId chain from the leaf. The leaf is the last row
   (what Pi loads), unless the host passes the leaf a live pane is on (a `/tree`
   move without a summary writes no row).
2. v1 files (linear, no ids) and v2 files (`hookMessage` role) are normalized
   the way Pi's own migration normalizes them.
3. Compaction follows `buildContextEntries`. The latest compaction on the
   branch becomes a `compaction` entry (`summarySource: 'carrier'`, plaintext).
   It is placed BEFORE the entries it keeps (`firstKeptEntryId`..compaction),
   because the neutral "after latest portable compaction" operation slices at
   the entry. In file order the kept entries precede the compaction row, and
   placing it there would erase them. Older compactions that fall inside the
   kept range contribute nothing in Pi, so they become opaque.
4. `context_edit` rows apply to their target the way `projectContextEntry`
   applies them. A `null` replacement drops the target, and a content
   replacement swaps only the content.
5. Rows map as Pi's `convertToLlm` maps them:
   - user → user;
   - assistant blocks in order: thinking → reasoning (signature as
     `encrypted`), text → assistant message, toolCall → tool-call;
   - toolResult → tool-result (`isError`);
   - `bashExecution` → user text via `bashExecutionToText`, or opaque when
     `excludeFromContext` (`!!`);
   - custom / custom_message → developer context;
   - branch_summary → developer context with Pi's exact prefix and suffix.
6. Aborted and errored assistant replies are opaque. Pi's `transformMessages`
   never replays them, and a switched-to provider must not receive half an
   answer as a finished one.
7. Everything else is opaque `pi.<type>` evidence and is never user speech:
   - the header, model/thinking changes, labels and session_info;
   - extension `custom` state;
   - Pi's own `system` message snapshot. A provider's system prompt is never
     carried as foreign instructions.

### Native-resume projector: a v3 file Pi opens with `--session-id`

- The output is a v3 header plus a LINEAR `id`/`parentId` chain with 8-hex ids,
  ordered deterministically by target session and index.
- A leading `custom` row, `agent-code.import`, marks the origin. `custom` rows
  are extension state that Pi never sends to a model.
- Consecutive assistant-side entries form one assistant message. A Pi source
  row keeps its native api/provider/model/usage. A foreign one gets an import
  marker, so Pi's own `transformMessages` treats it as another model's
  message: thinking becomes text, and signatures and redacted blocks are
  dropped. The projector does not guess at them.
- Tool results take `toolName` from their paired call. Unmatched calls and
  cycles that cross a user or compaction boundary are dropped and reported.
- A compaction becomes a native `compaction` row with
  `firstKeptEntryId = its own id`. That is Pi's own "keep nothing" convention
  (`appendCompaction(..., null)`), and everything after the row is context anyway.
- Foreign developer/system context becomes a labelled `custom_message`, which
  is user-level context and never Pi's system prompt.
- A Pi source row whose decoded meaning is unchanged is re-emitted natively
  (tool `details`, bash rows, custom messages, branch summaries) with new ids.
- Images must be base64 (`{type:'image', data, mimeType}`). URL images have no
  Pi representation and are dropped with a report entry.

### Archive projector

A coherent same-provider document re-emits the original rows once, in file
order. That is the active branch with its native ids, which is a valid chain.
Otherwise the native row shapes are used, with `atp_archive` provenance, and
opaque evidence goes in `custom` rows (`customType: 'atp_archive'`), which Pi
tolerates and never sends to a model.

## Verification

1. Fixtures (`fixtures/evidence/pi/`) are Stage 0 recordings of the real pi
   0.87.1 against the faux provider, minimized and path-normalized: tree, fork,
   compaction, tool, abort, error, `!bash`, plus v1/v2 durable shapes.
2. Decoder tests come first:
   - branch selection (abandoned turns absent);
   - compaction placement and the neutral slice keeping the kept entries;
   - abort and error exclusion;
   - bash text byte-identical to Pi's `bashExecutionToText`;
   - images, context_edit, v1/v2, and an explicit leaf.
3. Projector tests:
   - the native shape re-decodes to the same conversation;
   - the id chain is valid;
   - no foreign system prompt and no foreign signatures;
   - tool pairing and loss reporting;
   - compaction round trip.
4. Cross-provider: Pi → Claude/Codex/OpenCode/Grok → Pi keeps the user
   requests and the tool cycle, and the source stays immutable.
5. Native load (live, opt-in): the installed pi opens a projected file in a
   sandboxed agent dir with the faux provider and sends the imported history
   in its next request.
6. `npm run check`, and one review round in the app PR.

## Scope Limits

The parser owns JSON values, not directories, clocks or PTYs. The host names
the file `<ts>_<id>.jsonl` under Pi's session dir. `piSessionFileName` states
the naming rule, so the host does not re-derive it. A real-model (non-faux)
capture is not available because no Pi login exists on this machine, so thinking
signatures from a real provider are schema-evidenced, not recorded.

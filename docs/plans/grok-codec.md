# Grok Conversation Codec

Continues Agent Code #832 on `feat/grok-transcript-codec`. Implementation is
inline; orchestration children review only. No merge/release authorization.

## Contract

Add Grok as one decoder and one pair of target projectors, using the existing
provider-neutral document, archive/native-resume contracts and loss reports.
Do not introduce pairwise converters or import headless runtime code.

Recorded inputs establish flat tool calls, separate reasoning records, wrapped
user queries and an untagged user-info preamble. Pinned Grok source establishes
the image URL shape and that native loading supplies a system prompt when the
imported history has none. Provider system/bootstrap records remain provenance,
not foreign system instructions. Unknown records remain opaque and every native
projection omission/demotion is reported.

## Verification

1. Baseline `npm run check`: 131 tests, typecheck and packed entry verification.
2. Add minimized, privacy-reviewed recorded fixtures and decoder tests before
   implementation. Test semantic roles/order/tool pairing, not just round trips.
3. Add archive preservation and native projection tests. Only matched tool
   cycles enter native output; opaque provider records never become user speech.
   Preserve plaintext summaries as labeled context rather than manufacturing a
   native compaction boundary. Never carry foreign encrypted reasoning.
4. Compose the Grok decoder with existing Claude/Codex/OpenCode projectors and
   compose existing decoders with the Grok projector. Assert source immutability,
   meaningful history, pairing, explicit losses and native JSON shapes.
5. Verify the projected file set with the installed Grok CLI against a local
   fixture backend in an isolated home; assert imported history reaches the
   native request, the target supplies its own system instructions and a new
   turn appends. A pure archive pass is not a native-load guarantee.
6. Orchestrated read-only review, fixes, complete deterministic gate; no merge.

## Scope Limits

The parser owns JSON values, not PTYs, directories, auth or clocks. Grok's
`summary.json` is returned separately from native `chat_history.jsonl` values.
The host writes them atomically into a new session directory.

Full Grok compaction classification needs a real compacted capture. The
`compaction_meta` tag alone is insufficient (it also marks user-info prefixes).
Until that corpus exists, the decoder preserves those records as explicit
context, not a boundary that could truncate earlier history.

## Verified Progress

The decoder, archive projector and native-resume projector are implemented.
Cross-provider tests preserve user history, paired tool calls/results and URL
images through the existing Claude/Codex/OpenCode projectors and back. Native
Grok 1.0.13 loaded the generated file set in an isolated fixture-backed test,
inserted its native system prompt, sent the imported tool cycle in its actual
request and appended a new assistant response.

Read-only orchestration review found and verified fixes for duplicate archive
provenance, source-line collisions, context-label accumulation and image/tool
representation. Source identity is used for same-record grouping; no invented
parallel grouping is forced onto Codex's separate response-item records or
OpenCode's completed tool parts. Crossing detection is linear-time. Empty or
invalid assistant storage records remain explicit opaque evidence, rather than
being repaired into a tool invocation absent from the native schema.

Source inspection of Grok storage/jsonl/copy.rs established the counter split:
num_chat_messages counts chat-history items; num_messages counts replay events.
Since this profile does not synthesize replay events, num_messages is zero.
Session-picker presentation and real-server reuse of encrypted reasoning across
session/model/account changes remain unverified. The host must not describe
this profile as full UI switching or universal lossless native resumption.

Local verification: `npm run check` passed 163 deterministic tests plus source
typecheck, build and packed entry verification. The new test files were also
checked explicitly with strict TypeScript options. `GROK_PARSER_LIVE=1` with
`GROK_NATIVE_RESPONSE_FIXTURE` pointing at the minimized native response passed
the isolated installed-CLI gate. No remote CI, merge or full application-runtime
verification is claimed by these local checks.

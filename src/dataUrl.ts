/**
 * Split a `data:` URL into its declared media type and base64 payload.
 *
 * ── WHY THIS IS PROVIDER-NEUTRAL, AND NOT IN `claude/project/` ──
 * Every provider records an attachment as a data URL sooner or later, and a
 * second copy of this rule drifts from the first. It lived beside the Claude
 * projector until review pointed out the obvious consequence:
 * `import-boundaries.test.ts` forbids one provider's file from importing
 * another's, so a Claude-owned export could never be reached by the copy that
 * had ALREADY drifted — `grok/conversation/decode.ts`, whose `[^;,]+` refused
 * a legal `data:;base64,…`.
 *
 * That refusal was not harmless. Grok's decoder falls back to a
 * `{ type: 'url' }` carrier, and `claudeAttachmentBlock` copies a carrier it
 * recognises through VERBATIM and reports it `preserved` — writing
 * `source.type: 'url'` with a `data:` URL into a projected Claude transcript.
 * The Claude API rejects that block, it stays in history, and every later turn
 * fails. That is the exact poisoning the projector's own WHY exists to end.
 *
 * A neutral module is what lets the deduplication actually happen; it follows
 * `runtimeArtifact.ts`, which the Grok decoder already imports for the same
 * reason.
 *
 * ── WHAT IT REFUSES, DELIBERATELY ──
 * Media-type PARAMETERS before `;base64` (`data:image/png;charset=utf-8;base64,…`)
 * and an upper-case `;BASE64,`, although RFC 2397 permits both. No provider in
 * the corpus writes either: across 3.1 GB of Claude transcripts, 4.9 GB of
 * Codex rollouts, the OpenCode part store and the Grok rollouts, every
 * attachment data URL is `data:<mime>;base64,` or `data:;base64,` — zero
 * parameterized, zero upper-case. (The `;charset=utf-8;base64,` strings that a
 * raw grep finds are inline `sourceMappingURL=` source maps inside read-file
 * tool output, not attachments.)
 *
 * Widening the pattern changes what `claudeAttachmentBlock` will admit into a
 * projected transcript, which is not a decision to make as a side effect. Note
 * that refusing is only SAFE where the refusal is the last word: for a
 * Codex/OpenCode part it ends in `unrepresentable` and a change record, but
 * through Grok's carrier fallback it ends in the verbatim copy described
 * above. That is the other reason the Grok decoder must use this function
 * rather than its own.
 *
 * Returns null when the URL is not base64-encoded data. An empty media type is
 * a legal RESULT, not a failure — `data:;base64,…` is valid — and so is an
 * empty payload, because "declared as base64 data but empty" and "not a data
 * URL at all" are different facts and a caller cannot tell them apart if both
 * collapse to null.
 */
export function parseBase64DataUrl(url: string): { mediaType: string; data: string } | null {
  // Anchored and linear so a 700k-character payload (the recorded size) costs
  // one pass; the media type stops at the first `;` or `,` per RFC 2397.
  //
  // The leading `^` is load-bearing and is NOT decoration: without it,
  // `https://cdn.example/r?to=data:image/png;base64,AAAA` parses as inline
  // bytes, so a REFERENCE would be read as content — the precise distinction
  // this function exists to draw. `[\s\S]` rather than `.` because base64 in
  // the wild is sometimes line-wrapped, and `.` would make the whole match
  // fail against the `$` anchor, refusing a payload that is perfectly good.
  const match = /^data:([^;,]*);base64,([\s\S]*)$/.exec(url)
  if (!match) return null
  return { mediaType: match[1] ?? '', data: match[2] ?? '' }
}

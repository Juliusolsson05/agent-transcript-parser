Status: In progress

# Provider switches survive pasted images

Issues: #28 (shrink ladder), #29 (Claude projector). Follow-up filed, not fixed
here: #30 (image character estimate). Host side:
Juliusolsson05/agent-code#998, Juliusolsson05/agent-code#999.

## Outcome

A conversation that carries pasted images can be switched between providers in
both directions without a model call:

- Claude → OpenCode/Codex: the deterministic shrink ladder can remove attachment
  payload from messages and, when the protected recent turns are the only thing
  left over budget, reclaims payload inside them before it refuses. A 15-character
  prompt with a 549k-character base64 screenshot is no longer "unfittable".
- OpenCode/Codex → Claude: the Claude native-resume projector writes Claude
  `image`/`document` blocks for foreign image parts (or drops them with a
  reported loss) instead of copying `{type:'file'}` / `{type:'input_image'}`
  verbatim into a transcript the Claude API then rejects with a 400.

## Evidence this plan is built from

One real Claude transcript (1,100 decoded entries, 16 safe boundaries,
2,458,176 estimated characters) recorded on 2026-09-18:

| entry | kind | estimate | content |
|---|---|---|---|
| 1070 | user message | 714,226 | 129-char prompt + `opaque` 713,997-char OpenCode `file` part |
| 1079 | user message | 549,620 | 15-char prompt + `image` 549,526-char base64 PNG |
| 1080–1099 | opaque | 0 | attachments, `api_error` (400, `Input tag 'file'`), `turn_duration` |

Suffix cost from the last three boundaries: 1,294,156 / 1,280,149 / 549,620,
against a 288,000-character OpenCode budget. The ladder cleared 256 tool
outputs, trimmed 3 inputs and dropped 15 turns, then threw because the newest
turn is 99.98 % one image and no rung reads message content.

The fixtures committed in this repository cannot carry these sizes (census
caveat 1: redaction collapses them to 0.3–2.4 % of real bytes, and the only
observed image fixture holds the string `fixture text` as its data). Every
size-driven assertion below is therefore made on a conversation built in the
test from the recorded *shape*, which is what caveat 1 prescribes.

## Constraints

- The ladder stays provider-neutral: it never names a provider, never parses a
  provider's attachment `value` beyond treating it as an opaque payload, and
  keeps `operations/contextBudget.ts` as its single consumer.
- Never emit a turn fragment. The retained history still begins at a safe
  resume boundary; attachment clearing replaces a content item *inside* a
  message and leaves the message and its turn structurally complete.
- No lossy step is silent (design principle 3). Every new removal has a report
  counter, and lifting the recent-turn protection is itself reported.
- The estimator (`operations/estimate.ts`) is not changed. #30 records why the
  image estimate is wrong by ~100× and what a fix needs; changing the published
  estimate every host relies on is not folded into a bug fix.
- The Claude projector emits only observed native shapes. Base64 image and
  document blocks are observed (`claude-message-block-image`,
  `claude-message-block-document`); URL sources are not, so a non-data URL is
  dropped with a change record rather than guessed into a `source.type: 'url'`.

## Implementation

1. Plan (this file) as the first commit.
2. `operations/shrink.ts`
   - `clearAttachments(conversation, budget, options)`: rung 3. Walk messages
     oldest first up to the protected index; replace each `image`, `document`
     and `opaque` content item with a text placeholder
     `[<image|document|attachment> omitted during provider switch]` when the
     replacement is a net saving. Report `clearedAttachments`,
     `clearedAttachmentChars` (net).
   - `shrinkConversationToBudget`: two passes. Pass 1 is today's ladder with
     the new rung inserted (strip → results → attachments → inputs → drop). If
     the drop rung reports `stillExceedsBudget`, pass 2 re-runs the three
     clearing rungs with `keepRecentTurns: 0` on the pre-drop conversation and
     drops again. Only then throw. Report `liftedRecentTurnProtection: true`
     when pass 2 ran and removed anything.
   - `ShrinkReport` gains the three fields; `ConversationUnfittableError`
     message unchanged.
3. `operations/contextBudget.ts`: no logic change; the planner's `shrunk`
   outcome carries the extended report automatically. Comments that number the
   rungs are updated (rung 4 → rung 5 for the drop).
4. Tests, written before the implementation and failing first:
   - `testing/engine/shrink.test.ts`: `clearAttachments` unit cases (oldest
     first, protection honoured, all three content kinds, net-savings guard,
     text-only message untouched); the recorded-shape regression for #28 (a
     final turn that is a tiny prompt plus a huge image, an earlier user
     message with a huge opaque part, tool cycles before them — previously
     `ConversationUnfittableError`, now fits with the last user message kept
     and its image replaced); the lift for a final turn dominated by a tool
     output; and the case that must still throw (final turn's own text exceeds
     the budget).
   - `testing/engine/contextBudget.test.ts`: `planConversationContext` with
     `allowSourceTurns: false` returns `shrunk` with `clearedAttachments > 0`
     for the recorded shape.
   - Shared synthetic entry builders move from `contextBudget.test.ts` into
     `testing/engine/fixtureConversations.ts` so both suites build entries the
     same way.
5. `claude/project/nativeResume.ts` (#29): `claudeMessageContent` converts
   foreign image/document values. Claude-shaped values pass through; a
   `data:<mime>;base64,<data>` URL in `url` (OpenCode) or `image_url` (Codex)
   becomes a Claude `image` block for `image/*` and a `document` block for
   `application/pdf`, recorded as a `repaired` change; anything else is dropped
   with the existing `native-resume.content.<kind>.dropped` change. Tests in
   `testing/engine/nativeResumeProjection.test.ts` cover the OpenCode shape,
   the Codex shape, passthrough, and the drop.
6. README / package surface: `clearAttachments` is exported alongside the other
   rungs; `packageSurface.test.ts` updated if it enumerates exports.

## Verification

- `npm run check` in this package (contract, typecheck, all tests, packed
  surface) on Node 24.
- The recorded transcript replayed through `planConversationContext(…,
  'opencode', 288_000, { allowSourceTurns: false })` via a scratch script (not
  committed — it reads a personal transcript): must return `shrunk` under
  budget with the final user message retained.
- Host verification (tsc on both projects, the provider-switch test suite,
  `describeShrink`) happens in the agent-code bump PR.

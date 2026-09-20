import { describe, expect, it } from 'vitest'

import { parseBase64DataUrl } from '../../src/index.js'

// ---------------------------------------------------------------------------
// This lives in a provider-NEUTRAL module because attachment handling is
// cross-cutting and a second copy of the rule drifts from this one. Two copies
// had already drifted:
//
//   - Agent Code's Rewind draft told the user a legal `data:;base64,…`
//     attachment was an external REFERENCE — "the provider recorded a path
//     instead of the bytes" — with the bytes sitting right there.
//   - `grok/conversation/decode.ts` refused the same URL, fell through to the
//     `{type:'url'}` carrier, and `claudeAttachmentBlock` then copied that
//     carrier VERBATIM into a projected Claude transcript, reported as
//     preserved. The API rejects that block and every later turn fails.
//
// So the empty-media-type case is not an edge: it is the reason this is
// public, and it is pinned first.
// ---------------------------------------------------------------------------

describe('parseBase64DataUrl', () => {
  it('accepts a data URL that declares NO media type, which RFC 2397 allows', () => {
    expect(parseBase64DataUrl('data:;base64,AAAA')).toEqual({ mediaType: '', data: 'AAAA' })
  })

  it('reads the declared media type', () => {
    expect(parseBase64DataUrl('data:image/jpeg;base64,/9j/4AAQ'))
      .toEqual({ mediaType: 'image/jpeg', data: '/9j/4AAQ' })
  })

  it('does NOT accept media-type parameters before ;base64 — a known limit', () => {
    // RFC 2397 permits `data:image/png;charset=utf-8;base64,…`, and this
    // refuses it. Pinned rather than fixed: across 3.1 GB of Claude
    // transcripts, 4.9 GB of Codex rollouts, the OpenCode part store and the
    // Grok rollouts, every attachment data URL is `data:<mime>;base64,` or
    // `data:;base64,` — zero parameterized. (Claude itself emits no data URLs
    // at all; it records `source: {type:'base64', media_type, data}`.)
    //
    // Widening the pattern changes what `claudeAttachmentBlock` admits into a
    // projected transcript, which is not a decision to make as a side effect.
    // If a real one ever appears, this test is where to start.
    expect(parseBase64DataUrl('data:image/png;charset=utf-8;base64,AAAA')).toBeNull()
  })

  it('keeps a payload containing newlines intact', () => {
    // Base64 in the wild is sometimes line-wrapped. `.` instead of `[\\s\\S]`
    // does NOT truncate here — with the `$` anchor in place it makes the whole
    // match fail, so the payload is REFUSED outright. Refusal and silent
    // truncation are opposite failure modes, and it is worth being exact about
    // which one the character class prevents.
    expect(parseBase64DataUrl('data:image/png;base64,AA\nBB')?.data).toBe('AA\nBB')
  })

  it('is ANCHORED, so a reference containing a data URL is not read as content', () => {
    // The leading `^` is the whole distinction this function draws. Without
    // it, a link that merely mentions a data URL parses as inline bytes — a
    // reference silently promoted to content.
    expect(parseBase64DataUrl('https://cdn.example/redirect?to=data:image/png;base64,AAAA'))
      .toBeNull()
    expect(parseBase64DataUrl(' data:image/png;base64,AAAA')).toBeNull()
  })

  it('refuses an upper-case ;BASE64, marker', () => {
    // `nativeResume.ts` already documents this as a thing that is dropped, so
    // the claim should have a test rather than a comment. RFC 2397 permits it;
    // no provider in the corpus writes it.
    expect(parseBase64DataUrl('data:image/png;BASE64,AAAA')).toBeNull()
  })

  it('refuses anything that is not base64 data', () => {
    for (const url of ['data:text/plain,hello', 'https://example.test/a.png', '/tmp/a.png', 'data:', '']) {
      expect(parseBase64DataUrl(url), url).toBeNull()
    }
  })

  it('returns an empty payload rather than null when there is nothing after the comma', () => {
    // Distinguishing "declared as base64 data, but empty" from "not a data
    // URL" is the caller's business, and it cannot make that call if both
    // collapse to null.
    expect(parseBase64DataUrl('data:image/png;base64,')).toEqual({ mediaType: 'image/png', data: '' })
  })
})

describe('the Grok decoder uses the same rule', () => {
  // The copy that had already drifted. Grok's own `[^;,]+` refused a legal
  // `data:;base64,…`, fell through to the `{type:'url'}` carrier, and the
  // Claude projector copied that carrier VERBATIM into a projected transcript
  // — a `data:` URL under `source.type: 'url'`, which the API rejects, in
  // history, forever.
  it('decodes an image whose data URL declares no media type', async () => {
    const { decodeGrokConversation } = await import('../../src/index.js')
    const document = decodeGrokConversation([
      { type: 'user', prompt_index: 0, content: [{ type: 'image', url: 'data:;base64,AAAA' }] },
    ] as never)
    const message = document.entries.find(entry => entry.kind === 'message')
    const image = message?.kind === 'message'
      ? message.content.find(item => item.kind === 'image')
      : null
    expect(image?.value).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: '', data: 'AAAA' },
    })
  })
})

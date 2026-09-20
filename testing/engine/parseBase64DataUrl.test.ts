import { describe, expect, it } from 'vitest'

import { parseBase64DataUrl } from '../../src/index.js'

// ---------------------------------------------------------------------------
// This is exported because attachment handling is cross-cutting and a second
// copy of the rule drifts from this one. Agent Code's Rewind draft grew its
// own, stricter regex and consequently told the user a legal
// `data:;base64,…` attachment was an external REFERENCE — "the provider
// recorded a path instead of the bytes" — with the bytes sitting right there.
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
    // refuses it. Pinned rather than fixed: no provider in the corpus writes
    // one (Claude, Codex and OpenCode all emit `data:<mime>;base64,`), and
    // widening the pattern here changes what `claudeAttachmentBlock` accepts
    // into a projected transcript, which is not a decision to make as a side
    // effect. If a real one ever appears, this test is where to start.
    expect(parseBase64DataUrl('data:image/png;charset=utf-8;base64,AAAA')).toBeNull()
  })

  it('keeps a payload containing newlines intact', () => {
    // Base64 in the wild is sometimes wrapped; `.` would stop at the newline
    // and silently truncate the image.
    expect(parseBase64DataUrl('data:image/png;base64,AA\nBB')?.data).toBe('AA\nBB')
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

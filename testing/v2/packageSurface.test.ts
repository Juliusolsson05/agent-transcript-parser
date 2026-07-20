import { describe, expect, it } from 'vitest'

import * as v2 from '../../src/v2/index.js'

describe('v2 package composition surface', () => {
  it('exports neutral composition and independent provider adapters', () => {
    expect(v2.claudeConversationDecoder.provider).toBe('claude')
    expect(v2.codexConversationDecoder.provider).toBe('codex')
    expect(v2.claudeArchiveProjector.provider).toBe('claude')
    expect(v2.codexArchiveProjector.provider).toBe('codex')
    expect(v2.claudeNativeResumeProjector.profile.provider).toBe('claude')
    expect(v2.codexNativeResumeProjector.profile.provider).toBe('codex')
    expect(v2.translateArchive).toBeTypeOf('function')
    expect(v2.translateNativeResume).toBeTypeOf('function')
    expect(v2.cloneForNativeResume).toBeTypeOf('function')
    expect(v2.rewindForNativeResume).toBeTypeOf('function')
  })
})

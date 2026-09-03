import { describe, expect, it } from 'vitest'

import * as engine from '../../src/index.js'

describe('package composition surface', () => {
  it('exports neutral composition and independent provider adapters', () => {
    expect(engine.claudeConversationDecoder.provider).toBe('claude')
    expect(engine.codexConversationDecoder.provider).toBe('codex')
    expect(engine.opencodeConversationDecoder.provider).toBe('opencode')
    expect(engine.claudeArchiveProjector.provider).toBe('claude')
    expect(engine.codexArchiveProjector.provider).toBe('codex')
    expect(engine.claudeNativeResumeProjector.profile.provider).toBe('claude')
    expect(engine.codexNativeResumeProjector.profile.provider).toBe('codex')
    expect(engine.opencodeNativeResumeProjector.profile.provider).toBe('opencode')
    expect(engine.translateArchive).toBeTypeOf('function')
    expect(engine.translateNativeResume).toBeTypeOf('function')
    expect(engine.cloneForNativeResume).toBeTypeOf('function')
    expect(engine.rewindForNativeResume).toBeTypeOf('function')
  })

  it('keeps ghost behind its subpath and displaced pairwise APIs absent', () => {
    expect('toClaude' in engine).toBe(false)
    expect('createGhost' in engine).toBe(false)
  })
})

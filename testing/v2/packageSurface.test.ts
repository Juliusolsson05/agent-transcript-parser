import { describe, expect, it } from 'vitest'

import * as root from '../../src/index.js'
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

  it('backs the root API with v2 while keeping ghost behind its subpath', () => {
    expect(root.translateNativeResume).toBe(v2.translateNativeResume)
    expect(root.rewindConversation).toBe(v2.rewindConversation)
    expect('toClaude' in root).toBe(false)
    expect('createGhost' in root).toBe(false)
  })
})

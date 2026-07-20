import { describe, expect, it } from 'vitest'

import type { ConversationEntry } from '../../src/v2/conversation/types.js'
import { archiveProvenance } from '../../src/v2/projection/archiveProvenance.js'

function opaque(raw: Record<string, unknown>): ConversationEntry {
  return {
    kind: 'opaque',
    nativeType: 'future',
    timestamp: null,
    source: { provider: 'claude', line: 4, raw, evidence: [] },
  }
}

describe('bounded archive provenance', () => {
  it('strips nested ATP envelopes before embedding source', () => {
    const result = archiveProvenance(opaque({
      type: 'future',
      value: 'kept',
      _atp: { source: { secret: 'old recursive source' } },
      _atp_v2: { source: { secret: 'new recursive source' } },
    }))
    expect(result.source).toEqual({ type: 'future', value: 'kept' })
  })

  it('reports oversized source instead of recursively growing the target', () => {
    const result = archiveProvenance(opaque({ type: 'future', value: 'x'.repeat(500) }), 64)
    expect(result.source).toBeUndefined()
    expect(result.source_omitted).toBe(true)
    expect(result.source_bytes).toBeGreaterThan(64)
  })
})

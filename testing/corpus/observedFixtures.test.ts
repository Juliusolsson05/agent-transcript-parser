import { describe, expect, it } from 'vitest'

import { observedFamilyDescriptors, redactObservedValue } from './observedFixtures.js'

describe('observed fixture extraction', () => {
  it('derives reviewed schema families without using content values', () => {
    const descriptors = observedFamilyDescriptors('codex', {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'private prompt' }],
      },
    })

    expect(descriptors.map(value => value.caseId)).toEqual([
      'codex-record-response-item',
      'codex-payload-message',
      'codex-payload-role-user',
      'codex-payload-block-input-text',
    ])
    expect(JSON.stringify(descriptors)).not.toContain('private prompt')
  })

  it('redacts private scalars while preserving schema and id relationships', () => {
    const redacted = redactObservedValue({
      type: 'assistant',
      uuid: 'private-shared-id',
      parentUuid: 'private-shared-id',
      cwd: '/Users/private/customer-project',
      timestamp: '2026-07-20T12:34:56.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'PRIVATE_OUTPUT_9283' }],
      },
    }) as Record<string, unknown>
    const serialized = JSON.stringify(redacted)

    expect(serialized).toContain('"type":"assistant"')
    expect(serialized).toContain('"role":"assistant"')
    expect(redacted.uuid).toBe(redacted.parentUuid)
    expect(serialized).not.toContain('private-shared-id')
    expect(serialized).not.toContain('/Users/private')
    expect(serialized).not.toContain('PRIVATE_OUTPUT_9283')
    expect(serialized).not.toContain('12:34:56')
  })
})

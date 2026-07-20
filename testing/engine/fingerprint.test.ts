import { describe, expect, it } from 'vitest'

import { fingerprintJsonStructure } from '../../src/evidence/fingerprint.js'

describe('fingerprintJsonStructure', () => {
  it('keeps schema discriminators while excluding transcript scalar data', () => {
    const privateValues = {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'SECRET_PROMPT_7f3a' }],
        cwd: '/Users/private/customer-repository',
        command: 'security find-generic-password -wa account',
        id: 'session-secret-id',
      },
    }

    const result = fingerprintJsonStructure(privateValues)
    const serialized = JSON.stringify(result)

    expect(serialized).toContain('response_item')
    expect(serialized).toContain('message')
    expect(serialized).toContain('input_text')
    expect(serialized).not.toContain('SECRET_PROMPT_7f3a')
    expect(serialized).not.toContain('/Users/private')
    expect(serialized).not.toContain('security find-generic-password')
    expect(serialized).not.toContain('session-secret-id')
  })

  it('gives the same fingerprint to the same structure with different values', () => {
    const first = fingerprintJsonStructure({ type: 'user', message: { content: 'alpha' } })
    const second = fingerprintJsonStructure({ type: 'user', message: { content: 'beta' } })

    expect(first.fingerprint).toBe(second.fingerprint)
    expect(first.nodes).toEqual(second.nodes)
  })

  it('distinguishes a schema-defining discriminator change', () => {
    const user = fingerprintJsonStructure({ type: 'user', message: { content: 'same' } })
    const assistant = fingerprintJsonStructure({ type: 'assistant', message: { content: 'same' } })

    expect(user.fingerprint).not.toBe(assistant.fingerprint)
  })

  it('collapses unsafe dynamic object keys', () => {
    const result = fingerprintJsonStructure({
      metadata: {
        '/Users/private/repository/file.ts': 'value',
        'token with spaces': 3,
      },
    })
    const serialized = JSON.stringify(result)

    expect(serialized).not.toContain('/Users/private')
    expect(serialized).not.toContain('token with spaces')
    expect(serialized).toContain('<dynamic-string-key>')
    expect(serialized).toContain('<dynamic-number-key>')
  })

  it('treats array length as frequency rather than structure', () => {
    const one = fingerprintJsonStructure({ content: [{ type: 'text', text: 'one' }] })
    const many = fingerprintJsonStructure({
      content: [
        { type: 'text', text: 'one' },
        { type: 'text', text: 'two' },
        { type: 'text', text: 'three' },
      ],
    })

    expect(one.fingerprint).toBe(many.fingerprint)
  })
})

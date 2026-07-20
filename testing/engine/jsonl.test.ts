import { describe, expect, it } from 'vitest'

import {
  decodeJsonl,
  encodeJsonlDocument,
  encodeJsonlValues,
  parsedJsonlValues,
} from '../../src/jsonl/codec.js'

describe('raw JSONL codec', () => {
  it('preserves records, blank lines, malformed lines, terminators, and an active tail', () => {
    const source = '{"type":"user","value":null}\r\n\n{"broken":\n{"type":"assistant"}'
    const document = decodeJsonl(source)

    expect(document.lines.map(line => line.kind)).toEqual([
      'record',
      'blank',
      'malformed',
      'record',
    ])
    expect(document.lines.map(line => line.terminator)).toEqual(['\r\n', '\n', '\n', ''])
    expect(document.diagnostics.map(value => value.code)).toEqual([
      'invalid-json',
      'unterminated-line',
    ])
    expect(encodeJsonlDocument(document)).toBe(source)
    expect(parsedJsonlValues(document)).toEqual([
      { type: 'user', value: null },
      { type: 'assistant' },
    ])
  })

  it('does not invent a blank record for empty input or a final terminator', () => {
    expect(decodeJsonl('').lines).toEqual([])
    expect(decodeJsonl('{"type":"user"}\n').lines).toHaveLength(1)
    expect(decodeJsonl('{"type":"user"}\n').lines[0]?.unterminated).toBe(false)
  })

  it('encodes projected values with an explicit newline policy', () => {
    const values = [{ omitted: true }, { nullable: null }]
    expect(encodeJsonlValues(values)).toBe('{"omitted":true}\n{"nullable":null}\n')
    expect(encodeJsonlValues(values, { terminator: '\r\n', finalTerminator: false }))
      .toBe('{"omitted":true}\r\n{"nullable":null}')
  })
})

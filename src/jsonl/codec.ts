import type {
  EncodeJsonlValuesOptions,
  JsonlDiagnostic,
  JsonlLineTerminator,
  RawJsonlDocument,
  RawJsonlLine,
} from './types.js'

/**
 * Decode physical JSONL lines without normalizing the source.
 *
 * WHY raw text and terminators live beside parsed values: archive fidelity,
 * provider observation, and actively-written-tail handling all need facts that
 * `trim().split('\n').map(JSON.parse)` destroys before provider code runs. The
 * provider classifiers consume parsed `value`; exact re-emission consumes
 * `raw + terminator`. Neither is forced to impersonate the other.
 */
export function decodeJsonl(source: string): RawJsonlDocument {
  const lines: RawJsonlLine[] = []
  const diagnostics: JsonlDiagnostic[] = []
  let offset = 0
  let index = 0

  while (offset < source.length) {
    const newline = source.indexOf('\n', offset)
    const hasNewline = newline !== -1
    const end = hasNewline ? newline : source.length
    const hasCarriageReturn = hasNewline && end > offset && source[end - 1] === '\r'
    const rawEnd = hasCarriageReturn ? end - 1 : end
    const raw = source.slice(offset, rawEnd)
    const terminator: JsonlLineTerminator = hasNewline
      ? hasCarriageReturn
        ? '\r\n'
        : '\n'
      : ''
    const unterminated = terminator === ''
    const line = decodeLine(index, raw, terminator, unterminated)
    lines.push(line)
    if (line.kind === 'malformed') {
      diagnostics.push({
        line: index,
        code: 'invalid-json',
        severity: 'error',
        message: line.diagnostic.message,
      })
    }
    if (unterminated) {
      diagnostics.push({
        line: index,
        code: 'unterminated-line',
        severity: 'warning',
        message: 'Final physical line has no JSONL terminator.',
      })
    }
    offset = hasNewline ? newline + 1 : source.length
    index += 1
  }

  return { schemaVersion: 1, lines, diagnostics }
}

/** Exact source reconstruction, including blank/malformed lines and CRLF. */
export function encodeJsonlDocument(document: RawJsonlDocument): string {
  return document.lines.map(line => `${line.raw}${line.terminator}`).join('')
}

/**
 * Encode newly projected values. Projection code must call this explicitly;
 * it cannot accidentally pass a parsed document through `JSON.stringify` and
 * claim archive identity.
 */
export function encodeJsonlValues(
  values: readonly unknown[],
  options: EncodeJsonlValuesOptions = {},
): string {
  if (values.length === 0) return ''
  const terminator = options.terminator ?? '\n'
  const body = values.map(value => JSON.stringify(value)).join(terminator)
  return options.finalTerminator === false ? body : `${body}${terminator}`
}

export function parsedJsonlValues(document: RawJsonlDocument): unknown[] {
  return document.lines
    .filter((line): line is Extract<RawJsonlLine, { kind: 'record' }> => line.kind === 'record')
    .map(line => line.value)
}

function decodeLine(
  index: number,
  raw: string,
  terminator: JsonlLineTerminator,
  unterminated: boolean,
): RawJsonlLine {
  const base = { index, raw, terminator, unterminated }
  if (raw.trim().length === 0) return { ...base, kind: 'blank' }
  try {
    return { ...base, kind: 'record', value: JSON.parse(raw) }
  } catch (error) {
    return {
      ...base,
      kind: 'malformed',
      diagnostic: {
        code: 'invalid-json',
        // JSON.parse messages can vary by runtime, so callers use the stable
        // code for policy. The message remains useful local diagnostic context.
        message: error instanceof Error ? error.message : 'Invalid JSON',
      },
    }
  }
}

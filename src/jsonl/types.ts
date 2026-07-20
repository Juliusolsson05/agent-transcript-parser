export type JsonlLineTerminator = '\n' | '\r\n' | ''

export type RawJsonlLine =
  | ParsedJsonlLine
  | MalformedJsonlLine
  | BlankJsonlLine

interface JsonlLineBase {
  /** Zero-based physical position in the source, including blank lines. */
  index: number
  /** Source bytes decoded as a JavaScript string, excluding the terminator. */
  raw: string
  terminator: JsonlLineTerminator
  /**
   * A final line without a terminator is not automatically invalid JSON. It is
   * still important evidence because an actively written provider transcript
   * can be observed between the record write and its newline.
   */
  unterminated: boolean
}

export interface ParsedJsonlLine extends JsonlLineBase {
  kind: 'record'
  value: unknown
}

export interface MalformedJsonlLine extends JsonlLineBase {
  kind: 'malformed'
  diagnostic: {
    code: 'invalid-json'
    message: string
  }
}

export interface BlankJsonlLine extends JsonlLineBase {
  kind: 'blank'
}

export interface RawJsonlDocument {
  schemaVersion: 1
  lines: RawJsonlLine[]
  diagnostics: JsonlDiagnostic[]
}

export interface JsonlDiagnostic {
  line: number
  code: 'invalid-json' | 'unterminated-line'
  severity: 'warning' | 'error'
  message: string
}

export interface EncodeJsonlValuesOptions {
  terminator?: Exclude<JsonlLineTerminator, ''>
  finalTerminator?: boolean
}

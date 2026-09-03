/**
 * OpenCode's supported CLI export envelope.
 *
 * The nested payloads deliberately remain structural records. OpenCode evolves
 * its message/part schema independently; the decoder narrows only fields it can
 * prove and preserves each complete native message as `source.raw` for evidence.
 */
export interface OpencodeExportMessage {
  info: Record<string, unknown>
  parts: Record<string, unknown>[]
}

export interface OpencodeExportData {
  info: Record<string, unknown>
  messages: OpencodeExportMessage[]
}

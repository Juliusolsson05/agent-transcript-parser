import type { TranscriptGraphAnalysis, TranscriptInvariantDiagnostic } from '../../analysis/types.js'
import type { CodexPromptAddress, PromptReference } from '../../operations/promptAddress.js'
import type { CodexClassifiedRecord } from '../classify/types.js'

const CALL_TYPES = new Set(['function_call', 'custom_tool_call', 'local_shell_call'])
const RESULT_TYPES = new Set(['function_call_output', 'custom_tool_call_output', 'local_shell_call_output'])

export function analyzeCodexTranscript(records: readonly CodexClassifiedRecord[]): TranscriptGraphAnalysis {
  const diagnostics: TranscriptInvariantDiagnostic[] = []
  const meta = records.filter(record => record.family === 'session-meta')
  const sessionIds = uniqueStrings(meta.map(record => stringField(record.payload, 'id')))
  if (meta.length === 0) diagnostics.push(diagnostic('missing-session-meta', 'error', null, [], 'Codex snapshot has no session_meta record.'))
  if (meta.length > 1) diagnostics.push(diagnostic('multiple-session-meta', 'warning', meta[1]?.line ?? null, meta.map(value => value.line), 'Codex snapshot has multiple session_meta records.'))
  if (sessionIds.length > 1) diagnostics.push(diagnostic('multiple-session-identities', 'error', null, meta.map(value => value.line), 'Codex metadata records disagree on thread id.'))
  const sessionId = sessionIds[0] ?? null

  const prompts: Array<PromptReference<CodexPromptAddress>> = []
  const calls = new Map<string, number>()
  const results: Array<{ id: string; line: number }> = []
  const compactions: TranscriptGraphAnalysis['compactions'] = []

  for (const record of records) {
    if (record.family === 'response-item' && record.payload) {
      if (record.itemType === 'message' && record.payload.role === 'user') {
        prompts.push({ address: { provider: 'codex', line: record.line, sessionId }, raw: record.raw })
      }
      const callId = stringField(record.payload, 'call_id')
      if (callId && record.itemType && CALL_TYPES.has(record.itemType)) calls.set(callId, record.line)
      if (callId && record.itemType && RESULT_TYPES.has(record.itemType)) results.push({ id: callId, line: record.line })
    }
    if (record.family === 'compacted') compactions.push({ boundaryLine: record.line, summaryLine: record.line })
    if (record.family === 'event-message' && record.eventType === 'context_compacted') {
      compactions.push({ boundaryLine: record.line, summaryLine: null })
    }
    if (record.family === 'event-message' && record.eventType === 'thread_rolled_back') {
      diagnostics.push(diagnostic('history-rollback', 'info', record.line, [], 'Codex history contains a rollback mutation.'))
    }
  }

  const toolPairs: TranscriptGraphAnalysis['toolPairs'] = []
  const pairedCalls = new Set<string>()
  for (const result of results) {
    const callLine = calls.get(result.id)
    if (callLine === undefined) diagnostics.push(diagnostic('unmatched-tool-result', 'warning', result.line, [], 'Codex tool output has no matching call.'))
    else {
      pairedCalls.add(result.id)
      toolPairs.push({ callLine, resultLine: result.line, callId: result.id })
    }
  }
  for (const [id, line] of calls) {
    if (!pairedCalls.has(id)) diagnostics.push(diagnostic('unmatched-tool-call', 'warning', line, [], 'Codex tool call has no matching output.'))
  }
  return { provider: 'codex', sessionIds, prompts, diagnostics, toolPairs, compactions }
}

function diagnostic(
  code: TranscriptInvariantDiagnostic['code'],
  severity: TranscriptInvariantDiagnostic['severity'],
  line: number | null,
  relatedLines: number[],
  message: string,
): TranscriptInvariantDiagnostic {
  return { code, severity, line, relatedLines, message }
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  return record && typeof record[key] === 'string' ? record[key] as string : null
}

function uniqueStrings(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))]
}

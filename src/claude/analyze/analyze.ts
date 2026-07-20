import type { TranscriptGraphAnalysis, TranscriptInvariantDiagnostic } from '../../analysis/types.js'
import type { ClaudePromptAddress, PromptReference } from '../../operations/promptAddress.js'
import { isGhostRuntimeArtifact } from '../../runtimeArtifact.js'
import type { ClaudeClassifiedRecord } from '../classify/types.js'

export function analyzeClaudeTranscript(records: readonly ClaudeClassifiedRecord[]): TranscriptGraphAnalysis {
  // WHY analysis must share the decoder's ghost boundary: repeated snapshots
  // of one provisional ghost intentionally reuse a deterministic uuid. Treating
  // them as durable records creates false duplicate-id and dangling-parent
  // diagnostics even though projection correctly ignores every ghost.
  const durableRecords = records.filter(record => !isGhostRuntimeArtifact(record.raw))
  const sessionIds = uniqueStrings(durableRecords.map(record => stringField(record.raw, 'sessionId')))
  const diagnostics: TranscriptInvariantDiagnostic[] = []
  const prompts: Array<PromptReference<ClaudePromptAddress>> = []
  const ids = new Map<string, number>()
  const parents: Array<{ id: string; line: number }> = []
  const calls = new Map<string, number>()
  const results: Array<{ id: string; line: number }> = []
  const boundaries: number[] = []
  const summaries: number[] = []

  for (const record of durableRecords) {
    const uuid = stringField(record.raw, 'uuid')
    if (uuid) {
      const previous = ids.get(uuid)
      if (previous !== undefined) {
        diagnostics.push(diagnostic('duplicate-record-id', 'error', record.line, [previous], 'Claude uuid appears more than once.'))
      } else ids.set(uuid, record.line)
    }
    const parent = stringField(record.raw, 'parentUuid')
    if (parent) parents.push({ id: parent, line: record.line })

    if (record.family === 'user-message') {
      if (
        record.raw.isMeta !== true &&
        record.raw.isCompactSummary !== true &&
        containsHumanPromptContent(record.message?.content)
      ) {
        prompts.push({
          address: {
            provider: 'claude',
            line: record.line,
            sessionId: stringField(record.raw, 'sessionId'),
            uuid,
          },
          raw: record.raw,
        })
      }
      if (record.raw.isCompactSummary === true) summaries.push(record.line)
    }
    if (record.family === 'system' && record.subtype === 'compact_boundary') boundaries.push(record.line)

    for (const block of record.family === 'user-message' || record.family === 'assistant-message'
      ? record.blocks
      : []) {
      if (!isRecord(block.raw)) continue
      if (block.family === 'tool_use' && typeof block.raw.id === 'string') calls.set(block.raw.id, record.line)
      if (block.family === 'tool_result' && typeof block.raw.tool_use_id === 'string') {
        results.push({ id: block.raw.tool_use_id, line: record.line })
      }
    }
  }

  if (sessionIds.length > 1) {
    diagnostics.push(diagnostic('multiple-session-identities', 'error', null, [], 'Claude records contain multiple sessionId values.'))
  }
  for (const parent of parents) {
    if (!ids.has(parent.id)) diagnostics.push(diagnostic('dangling-parent', 'warning', parent.line, [], 'Claude parentUuid is absent from this snapshot.'))
  }

  const toolPairs: TranscriptGraphAnalysis['toolPairs'] = []
  const pairedCalls = new Set<string>()
  for (const result of results) {
    const callLine = calls.get(result.id)
    if (callLine === undefined) {
      diagnostics.push(diagnostic('unmatched-tool-result', 'warning', result.line, [], 'Claude tool_result has no matching tool_use.'))
    } else {
      pairedCalls.add(result.id)
      toolPairs.push({ callLine, resultLine: result.line, callId: result.id })
    }
  }
  for (const [id, line] of calls) {
    if (!pairedCalls.has(id)) diagnostics.push(diagnostic('unmatched-tool-call', 'warning', line, [], 'Claude tool_use has no matching tool_result.'))
  }

  const compactions = boundaries.map(boundaryLine => {
    const summaryLine = summaries.find(line => line > boundaryLine) ?? null
    if (summaryLine === null) diagnostics.push(diagnostic('compaction-summary-missing', 'warning', boundaryLine, [], 'Claude compact boundary has no later compact summary.'))
    return { boundaryLine, summaryLine }
  })
  return { provider: 'claude', sessionIds, prompts, diagnostics, toolPairs, compactions }
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

function stringField(record: Record<string, unknown>, key: string): string | null {
  return typeof record[key] === 'string' ? record[key] as string : null
}

function uniqueStrings(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function containsHumanPromptContent(content: unknown): boolean {
  if (typeof content === 'string') return content.trim().length > 0
  if (!Array.isArray(content)) return false
  // WHY top-level `type:user` is insufficient: Claude persists tool_result
  // delivery as a user-role message. Counting that record produces rewind
  // anchors the human never saw as prompts. Text and user-supplied media are
  // prompt-bearing; a tool-result-only envelope is continuation plumbing.
  return content.some(block => {
    if (!isRecord(block)) return false
    if (block.type === 'text') return typeof block.text === 'string' && block.text.trim().length > 0
    return block.type === 'image' || block.type === 'document'
  })
}

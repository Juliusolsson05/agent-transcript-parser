import type { ConversationEntry } from '../conversation/types.js'
import type { ProjectionChange, ProjectionChangeKind } from '../report/types.js'

export function nativeResumeChange(
  entry: ConversationEntry,
  targetProvider: string,
  kind: ProjectionChangeKind,
  code: string,
  message: string,
): ProjectionChange {
  return {
    kind,
    sourceProvider: entry.source.provider,
    sourceLine: entry.source.line,
    targetProvider,
    code,
    message,
    // Reports may append target-profile evidence. Copying prevents that useful
    // annotation from mutating the neutral source document behind the caller's
    // back, which would make a second projection order-dependent.
    evidence: [...entry.source.evidence],
  }
}

export function synthesizedNativeResumeChange(
  sourceProvider: string,
  targetProvider: string,
  code: string,
  message: string,
): ProjectionChange {
  return {
    kind: 'synthesized',
    sourceProvider,
    sourceLine: null,
    targetProvider,
    code,
    message,
    evidence: [],
  }
}

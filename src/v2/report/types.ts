import type { EvidenceClaim } from '../evidence/claim.js'

export type ProjectionChangeKind =
  | 'preserved'
  | 'dropped'
  | 'demoted'
  | 'synthesized'
  | 'repaired'
  | 'retargeted'
  | 'opaque'

export interface ProjectionChange {
  kind: ProjectionChangeKind
  sourceProvider: 'claude' | 'codex' | null
  sourceLine: number | null
  targetProvider: 'claude' | 'codex'
  code: string
  message: string
  evidence: EvidenceClaim[]
}

export interface ProjectionReport {
  profile: 'archive' | 'native-resume'
  sourceProvider: 'claude' | 'codex'
  targetProvider: 'claude' | 'codex'
  changes: ProjectionChange[]
  counts: Record<ProjectionChangeKind, number>
}

export function createProjectionReport(
  profile: ProjectionReport['profile'],
  sourceProvider: ProjectionReport['sourceProvider'],
  targetProvider: ProjectionReport['targetProvider'],
  changes: ProjectionChange[],
): ProjectionReport {
  const counts: ProjectionReport['counts'] = {
    preserved: 0,
    dropped: 0,
    demoted: 0,
    synthesized: 0,
    repaired: 0,
    retargeted: 0,
    opaque: 0,
  }
  for (const change of changes) counts[change.kind] += 1
  return { profile, sourceProvider, targetProvider, changes, counts }
}

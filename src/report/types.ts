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
  sourceProvider: string | null
  sourceLine: number | null
  targetProvider: string
  code: string
  message: string
  evidence: EvidenceClaim[]
}

export interface ProjectionReport {
  profile: 'archive' | 'native-resume'
  sourceProvider: string
  targetProvider: string
  changes: ProjectionChange[]
  counts: Record<ProjectionChangeKind, number>
}

export function createProjectionReport<
  TProfile extends ProjectionReport['profile'],
  TTargetProvider extends string,
>(
  profile: TProfile,
  sourceProvider: ProjectionReport['sourceProvider'],
  targetProvider: TTargetProvider,
  changes: ProjectionChange[],
): ProjectionReport & { profile: TProfile; targetProvider: TTargetProvider } {
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

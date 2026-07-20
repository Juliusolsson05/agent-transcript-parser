import type { ProjectionReport } from '../report/types.js'

export interface ProjectionOptions {
  targetSessionId: string
  /** Caller-supplied time keeps the pure engine deterministic and testable. */
  now: string
  /** Archive provenance is bounded even when the source contains prior archives. */
  maxEmbeddedSourceBytes?: number
}

export interface ProjectionResult {
  values: Record<string, unknown>[]
  report: ProjectionReport
}

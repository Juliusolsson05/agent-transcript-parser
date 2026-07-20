import type { ProjectionReport } from '../report/types.js'
import type { ConversationDocument } from '../conversation/types.js'

export interface ProjectionBaseOptions {
  targetSessionId: string
  /** Caller-supplied time keeps the pure engine deterministic and testable. */
  now: string
}

export interface ArchiveProjectionOptions extends ProjectionBaseOptions {
  /** Archive provenance is bounded even when the source contains prior archives. */
  maxEmbeddedSourceBytes?: number
  /**
   * Archive UUIDs must be reproducible in tests and caller-controlled when a
   * host has stronger identity requirements. Resume projectors will have their
   * own stricter identity contract rather than silently reusing this one.
   */
  idFactory?: (seed: string) => string
}

export interface ArchiveProjectionResult<TProvider extends string = string> {
  profile: 'archive'
  targetProvider: TProvider
  values: Record<string, unknown>[]
  report: ProjectionReport & { profile: 'archive'; targetProvider: TProvider }
}

/**
 * The archive projector is the only target-facing contract shared code needs.
 * A future provider supplies one implementation of this interface; it never
 * needs to import or know about any existing provider adapter.
 */
export interface ArchiveProjector<TProvider extends string = string> {
  readonly provider: TProvider
  projectArchive(
    conversation: ConversationDocument,
    options: ArchiveProjectionOptions,
  ): ArchiveProjectionResult<TProvider>
}

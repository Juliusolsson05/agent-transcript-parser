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

export interface NativeResumeProfile<TProvider extends string = string> {
  id: string
  provider: TProvider
  /** A resume guarantee is only as broad as the evidence coordinate here. */
  evidence: {
    sourceCommit?: string
    cliVersion?: string
    observedAt?: string
  }
}

export interface NativeResumeProjectionResult<
  TProvider extends string = string,
  TProfile extends NativeResumeProfile<TProvider> = NativeResumeProfile<TProvider>,
> {
  profile: 'native-resume'
  targetProvider: TProvider
  providerProfile: TProfile
  values: Record<string, unknown>[]
  report: ProjectionReport & { profile: 'native-resume'; targetProvider: TProvider }
}

/**
 * Resume projectors intentionally do not extend ArchiveProjector. Keeping the
 * methods and result discriminants separate prevents a fidelity-oriented
 * archive—with unknown extension records—from being passed to a native CLI by
 * accident merely because both operations happen to emit JSON objects.
 */
export interface NativeResumeProjector<
  TProvider extends string,
  TOptions extends ProjectionBaseOptions,
  TProfile extends NativeResumeProfile<TProvider>,
> {
  readonly provider: TProvider
  readonly profile: TProfile
  projectNativeResume(
    conversation: ConversationDocument,
    options: TOptions,
  ): NativeResumeProjectionResult<TProvider, TProfile>
}

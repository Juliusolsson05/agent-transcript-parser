/**
 * Evidence provenance is part of the v2 data model because the same JSON shape
 * can support radically different claims depending on where it came from. A
 * synthetic regression case may prove a parser branch stays stable; it cannot
 * prove that a native CLI writes or resumes that shape. Keeping provenance in
 * the fixture rather than in prose prevents a future green test suite from
 * silently promoting weak evidence into a provider contract.
 */
export type EvidenceProvenance =
  | 'observed-wire'
  | 'pinned-upstream-source'
  | 'controlled-native-observation'
  | 'agent-code-consumer'
  | 'human-reviewed-semantics'
  | 'synthetic-regression'
  | 'v1-compatibility'
  | 'self-round-trip'

// WHY this is deliberately open-ended instead of a Claude/Codex union: the
// evidence model is shared infrastructure for every future adapter. Requiring
// a central union edit for each provider would make the supposedly neutral
// layer a hidden registry and would eventually recreate pairwise coupling.
export type TranscriptProvider = string

export type EvidenceClaimStage =
  | 'wire-shape'
  | 'classification'
  | 'archive-fidelity'
  | 'native-discovery'
  | 'native-load'
  | 'native-reconstruction'
  | 'native-append'
  | 'semantic-translation'
  | 'agent-code-consumer'

export interface ProviderEvidenceProfile {
  provider: TranscriptProvider
  /** Human-readable CLI version when the capture made it observable. */
  cliVersion?: string
  /** Source commit for source-derived rules. It is not inferred from cliVersion. */
  sourceCommit?: string
  /** Schema coordinate or digest when a published schema is the oracle. */
  schemaVersion?: string
  platform?: string
}

export interface FixtureEvidenceManifest {
  schemaVersion: 1
  caseId: string
  description: string
  provider: TranscriptProvider
  format: 'jsonl'
  provenance: EvidenceProvenance
  profile: ProviderEvidenceProfile
  capturedAt?: string
  reviewedAt: string
  /**
   * Names the transformations without pretending the redacted fixture is still
   * byte-identical to private source material.
   */
  normalization: string[]
  redactions: string[]
  features: string[]
  proves: EvidenceClaimStage[]
  doesNotProve: EvidenceClaimStage[]
  source: {
    kind: 'local-observation' | 'vendored-source' | 'schema' | 'synthetic'
    /** Digest of the private/source input; never its path or session id. */
    sha256?: string
    reference?: string
  }
}

export interface StructuralShapeNode {
  path: string
  kind: 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object'
  /**
   * Only a deliberately tiny discriminator allowlist may retain scalar values.
   * Arbitrary transcript text, ids, paths, commands, and outputs never enter a
   * structural catalog.
   */
  discriminator?: string
}

export interface StructuralFingerprint {
  schemaVersion: 1
  fingerprint: string
  nodes: StructuralShapeNode[]
  truncated: boolean
}

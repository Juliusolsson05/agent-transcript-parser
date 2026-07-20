import type { EvidenceProvenance, ProviderEvidenceProfile } from './types.js'

export interface EvidenceClaim {
  provenance: EvidenceProvenance
  rule: string
  profile: ProviderEvidenceProfile
}

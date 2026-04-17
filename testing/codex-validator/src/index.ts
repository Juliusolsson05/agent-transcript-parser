// Public surface of the Codex rollout validator.
//
// Kept minimal on purpose: callers either want `validateRollout` (the
// main entry point) or the report types. If we ever add Tier 2
// (`roundtripRollout` via the Rust binary), export it from here too.

export { validateRollout } from './validate.js'
export type { ValidationIssue, ValidationReport, ValidationSeverity } from './types.js'

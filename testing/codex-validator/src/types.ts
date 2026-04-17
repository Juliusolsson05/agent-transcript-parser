// Shared types for the Codex rollout validator.
//
// Kept deliberately small: the report is consumed by test harnesses,
// CLIs, and the translator's own verify.ts. Anything exotic (structured
// diff of round-tripped bytes, etc.) belongs on the specific report
// surface that produces it, not on the common type.

export type ValidationSeverity = 'error' | 'warn'

export type ValidationIssue = {
  severity: ValidationSeverity
  /**
   * Stable machine-readable identifier. Use this in fixture tests to
   * assert on specific failure modes rather than regex-matching
   * `message`. Non-exhaustive: new codes land as we encounter new
   * failure classes.
   *
   * Conventions:
   *   - "schema"                  — any ajv-reported shape violation
   *   - "invariant.<name>"        — a cross-line or value-semantic check
   *     from invariants.ts (e.g. "invariant.local_shell_env_not_null")
   */
  code: string
  /** Line number, 1-indexed. Omitted for stream-level issues. */
  line?: number
  /** JSON Pointer into the offending line, or "/" for the root. */
  path: string
  message: string
}

export type ValidationReport = {
  /** True iff there are no `severity: 'error'` issues. */
  ok: boolean
  errorCount: number
  warnCount: number
  issues: ValidationIssue[]
}

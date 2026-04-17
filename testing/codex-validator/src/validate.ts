// Tier 1 validator: structural validation of Codex rollout JSONL against
// vendored upstream schemas. No Rust, no cargo, no network — just ajv.
//
// What this catches:
//   - any shape violation the upstream ResponseItem / LocalShellAction /
//     ContentItem / Reasoning* / etc. schemas define (missing required
//     fields, wrong types, unknown enum variants within known tags)
//   - envelope violations (missing timestamp / type / payload, unknown
//     top-level type)
//   - SessionMetaLine / TurnContextItem / CompactedItem / EventMsg
//     envelope violations per our hand-authored schema
//
// What this does NOT catch:
//   - cross-line rules (call_id pairing, session_meta ordering, etc.) —
//     see invariants.ts. JSON Schema can't express those.
//   - field-value semantics beyond what the schema encodes (e.g. env
//     can be `null` per the schema but the OpenAI API rejects it) —
//     these also live in invariants.ts as targeted checks.
//   - serde-level deserialization bugs that only manifest in the real
//     Rust code (Tier 2's job via the round-trip binary).
//
// Design choices:
//   - One Ajv instance per validator load, so schemas compile once.
//   - addSchema + $ref across files: the envelope schema references
//     `codex-v2.schemas.json#/definitions/ResponseItem`. Ajv resolves
//     cross-file refs if we register both schemas with their $id.
//   - We don't `strict: true`. Upstream schemas have some patterns Ajv
//     would reject under strict mode (writeOnly on required fields,
//     etc.) — strict mode is useful for schema AUTHORS, not consumers
//     of someone else's schemas.

import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { runInvariants } from './invariants.js'
import type { ValidationIssue, ValidationReport } from './types.js'

const here = dirname(fileURLToPath(import.meta.url))
const SCHEMAS_DIR = join(here, '..', 'schemas')

// Lazy singleton — first call pays the compile cost, subsequent calls
// reuse compiled validators. Important for the fixture test loop and
// for repeated `validateRollout` calls inside verify.ts.
let cachedValidator: ((line: unknown) => ValidationIssue[]) | null = null

function buildValidator(): (line: unknown) => ValidationIssue[] {
  if (cachedValidator) return cachedValidator

  // allowUnionTypes: upstream schemas use `{"type": ["string", "null"]}`
  // extensively. allErrors: we want every problem per line, not just
  // the first — makes the report useful for translators that emit
  // multiple bad lines in one run.
  const ajv = new Ajv({
    allErrors: true,
    allowUnionTypes: true,
    strict: false,
    // $data: false — we don't use $data refs; keep the surface small.
  })
  addFormats(ajv)

  const upstream = JSON.parse(
    readFileSync(join(SCHEMAS_DIR, 'codex-v2.schemas.json'), 'utf8'),
  ) as Record<string, unknown>
  const envelope = JSON.parse(
    readFileSync(join(SCHEMAS_DIR, 'rollout-envelope.schema.json'), 'utf8'),
  ) as Record<string, unknown>

  // Register upstream under the $id the envelope schema expects. If
  // upstream doesn't declare $id (it doesn't today), ajv would refuse
  // to resolve the cross-file $ref. We force an $id here so the
  // envelope's `$ref: "codex-v2.schemas.json#/..."` resolves.
  ajv.addSchema(upstream, 'codex-v2.schemas.json')
  const validate = ajv.compile(envelope)

  cachedValidator = (line: unknown) => {
    const ok = validate(line)
    if (ok) return []
    return (validate.errors ?? []).map(err => ({
      severity: 'error' as const,
      code: 'schema',
      path: err.instancePath || '/',
      message: `${err.message ?? 'schema violation'}${
        err.params && Object.keys(err.params).length > 0
          ? ` (${JSON.stringify(err.params)})`
          : ''
      }`,
    }))
  }
  return cachedValidator
}

/**
 * Validate an array of Codex rollout lines. Runs Tier 1 (schema) and
 * the cross-line invariants; never throws, always returns a report.
 *
 * One "line" is one parsed JSON object — callers are responsible for
 * JSONL.parseLines upstream, because JSONL parse errors are already a
 * different class of error (malformed bytes, not malformed shape).
 */
export function validateRollout(lines: readonly unknown[]): ValidationReport {
  const validate = buildValidator()
  const issues: ValidationIssue[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (const issue of validate(line)) {
      issues.push({ ...issue, line: i + 1 })
    }
  }

  // Invariants pass over the whole stream. Runs even when schema
  // errors exist — they target different failure classes and a caller
  // reading the report wants to see both.
  for (const issue of runInvariants(lines)) {
    issues.push(issue)
  }

  return {
    ok: issues.every(i => i.severity !== 'error'),
    errorCount: issues.filter(i => i.severity === 'error').length,
    warnCount: issues.filter(i => i.severity === 'warn').length,
    issues,
  }
}

export type { ValidationIssue, ValidationReport } from './types.js'

// Cross-line and value-semantic invariants that JSON Schema cannot
// express. Each invariant emits zero or more ValidationIssue records.
//
// Philosophy: every check in this file is the distilled lesson from
// a real bug. If an invariant fires on real Codex sessions captured
// from `~/.codex/sessions/`, the invariant is wrong, not the session.
// The upstream schema is intentionally permissive in places where the
// OpenAI /v1/responses API or Codex's own normalizers are strict; the
// invariants encode those tighter rules.
//
// Each invariant is a pure function over the whole line stream so the
// caller can reorder or disable them without side effects.

import type { ValidationIssue } from './types.js'

type Line = Record<string, unknown>

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// ---------------------------------------------------------------------
// Invariant: local_shell_call.action.env must be an object, not null.
//
// Why it's not enforced by the schema: upstream Codex protocol allows
// `env: null` (see LocalShellAction.json — `"type": ["object", "null"]`),
// because the Rust struct is `Option<HashMap<String, String>>` and the
// rollout writer tolerates missing env.
//
// Why we still want to fail the check: the OpenAI /v1/responses API
// rejects replays where a hosted local_shell_call carries `env: null`
// with `Invalid type for 'input[N].action.env': expected an object with
// string keys and string values, but got null instead.` Codex happily
// writes these to disk, but the next resume is dead on arrival. The
// translator also emits `local_shell_call` in some paths — this check
// prevents that from shipping.
//
// `env` absent is FINE (it's Option<_>, skip_serializing_if = none).
// `env: null` is the specific failure mode.
// ---------------------------------------------------------------------
function* checkLocalShellEnv(lines: readonly unknown[]): Iterable<ValidationIssue> {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as Line
    if (!isRecord(line) || line.type !== 'response_item') continue
    const payload = line.payload as Line | undefined
    if (!isRecord(payload) || payload.type !== 'local_shell_call') continue
    const action = payload.action as Line | undefined
    if (!isRecord(action)) continue
    // Distinguish "env present but null" from "env absent".
    if ('env' in action && action.env === null) {
      yield {
        severity: 'error',
        code: 'invariant.local_shell_env_not_null',
        line: i + 1,
        path: '/payload/action/env',
        message:
          'local_shell_call.action.env is null; OpenAI /v1/responses rejects this on replay with invalid_type. Emit an empty object {} or omit the field.',
      }
    }
  }
}

// ---------------------------------------------------------------------
// Invariant: function_call.arguments must parse as JSON.
//
// Why: Codex's normalizer and OpenAI's API expect `arguments` to be a
// JSON-encoded string. If the translator emitted something that
// doesn't parse, the model/server behaviour on resume is undefined.
// The convention is documented in codex-rs/protocol/src/models.rs and
// in the Responses API reference.
// ---------------------------------------------------------------------
function* checkFunctionCallArgumentsJson(
  lines: readonly unknown[],
): Iterable<ValidationIssue> {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as Line
    if (!isRecord(line) || line.type !== 'response_item') continue
    const payload = line.payload as Line | undefined
    if (!isRecord(payload)) continue
    if (payload.type !== 'function_call' && payload.type !== 'custom_tool_call') continue
    const field = payload.type === 'function_call' ? 'arguments' : 'input'
    const raw = payload[field]
    if (typeof raw !== 'string') {
      // Schema will already flag non-string; skip so we don't
      // double-report.
      continue
    }
    try {
      JSON.parse(raw)
    } catch (err) {
      yield {
        severity: 'error',
        code: 'invariant.tool_args_not_json',
        line: i + 1,
        path: `/payload/${field}`,
        message: `${payload.type}.${field} is not valid JSON: ${(err as Error).message}`,
      }
    }
  }
}

// ---------------------------------------------------------------------
// Invariant: every function_call_output / custom_tool_call_output's
// call_id should pair with an earlier function_call / custom_tool_call.
//
// Why: Codex's history normalizer and Claude's tool-pairing pass will
// synthesize fake `is_error: true` stubs or drop orphaned outputs on
// resume, silently corrupting the transcript. This check catches
// ordering bugs in the translator BEFORE they reach the resume path.
//
// Intentionally loose: we only look for a matching call_id anywhere
// earlier in the stream, not strict adjacency — Codex allows
// interleaved reasoning/text between call and output.
// ---------------------------------------------------------------------
function* checkCallIdPairing(
  lines: readonly unknown[],
): Iterable<ValidationIssue> {
  const seenCallIds = new Set<string>()
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as Line
    if (!isRecord(line) || line.type !== 'response_item') continue
    const payload = line.payload as Line | undefined
    if (!isRecord(payload)) continue
    const t = payload.type
    const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined
    if (!callId) continue
    if (t === 'function_call' || t === 'custom_tool_call' || t === 'local_shell_call') {
      seenCallIds.add(callId)
    } else if (t === 'function_call_output' || t === 'custom_tool_call_output') {
      if (!seenCallIds.has(callId)) {
        yield {
          severity: 'error',
          code: 'invariant.orphaned_tool_output',
          line: i + 1,
          path: '/payload/call_id',
          message: `${t}.call_id "${callId}" has no prior matching tool_call. Codex resume normalizers synthesize fake error stubs or drop orphaned outputs — this means state loss on resume.`,
        }
      }
    }
  }
}

// ---------------------------------------------------------------------
// Invariant: session_meta must appear at most once, and must come
// before any response_item / event_msg (except task boundary events
// which the translator prepends for framing).
//
// Why: Codex's rollout list/resume discovery scans the first ~10 lines
// for session_meta. Finding it late — or finding two of them — causes
// the file to be filtered out of the picker (see
// codex-rs/rollout/src/list.rs). A silent discovery failure, not a
// crash.
//
// Translator-synthesized lines are allowed to precede (they carry
// `_atp: { origin: "synthesized" }` in fidelity mode) because toClaude
// absorbs them into context without emitting entries — but we don't
// check `_atp` here because lossy mode strips it, and the invariant
// must hold in both modes.
// ---------------------------------------------------------------------
function* checkSessionMetaOrdering(
  lines: readonly unknown[],
): Iterable<ValidationIssue> {
  let seenContentBeforeMeta = -1
  let metaLines: number[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as Line
    if (!isRecord(line)) continue
    if (line.type === 'session_meta') {
      metaLines.push(i + 1)
    } else if (line.type === 'response_item' || line.type === 'compacted') {
      // event_msg is excluded from the "content before meta" check
      // because the translator prepends user_message / task_started
      // events before any response_item, and those are boundary
      // signals Codex expects to see early.
      if (metaLines.length === 0 && seenContentBeforeMeta === -1) {
        seenContentBeforeMeta = i + 1
      }
    }
  }

  if (metaLines.length > 1) {
    yield {
      severity: 'error',
      code: 'invariant.session_meta_duplicated',
      line: metaLines[1],
      path: '/type',
      message: `session_meta appears ${metaLines.length} times (lines ${metaLines.join(', ')}). Codex resume expects exactly one.`,
    }
  }
  if (metaLines.length === 0) {
    yield {
      severity: 'warn',
      code: 'invariant.session_meta_missing',
      path: '/',
      message:
        'No session_meta line found. Codex resume discovery will skip this file. OK for synthetic/partial transcripts; error for anything meant to be resumable.',
    }
  }
  if (metaLines.length === 1 && seenContentBeforeMeta !== -1 && seenContentBeforeMeta < metaLines[0]) {
    yield {
      severity: 'error',
      code: 'invariant.session_meta_late',
      line: metaLines[0],
      path: '/',
      message: `session_meta at line ${metaLines[0]} appears after content at line ${seenContentBeforeMeta}. Codex's resume picker scans the first few lines for session_meta; late placement causes silent discovery failures.`,
    }
  }
}

// ---------------------------------------------------------------------
// Invariant: response_item.message with role='user' should appear at
// least once in a transcript that expects to be resumable.
//
// Why: codex-rs/rollout/src/list.rs filters the picker on a
// `saw_user_event` signal. Without a user event, the file exists on
// disk but `codex resume` refuses to show it. This is a warn, not an
// error — pure agent-loop transcripts sometimes legitimately lack one.
// ---------------------------------------------------------------------
function* checkSawUserEvent(
  lines: readonly unknown[],
): Iterable<ValidationIssue> {
  let sawUserResponseItem = false
  let sawUserEvent = false
  for (const line of lines) {
    if (!isRecord(line)) continue
    if (line.type === 'response_item') {
      const p = line.payload as Line | undefined
      if (isRecord(p) && p.type === 'message' && p.role === 'user') {
        sawUserResponseItem = true
      }
    }
    if (line.type === 'event_msg') {
      const p = line.payload as Line | undefined
      if (isRecord(p) && p.type === 'user_message') sawUserEvent = true
    }
  }
  if (!sawUserResponseItem || !sawUserEvent) {
    const missing = [
      !sawUserResponseItem ? 'response_item.message(role=user)' : null,
      !sawUserEvent ? 'event_msg.user_message' : null,
    ].filter(Boolean)
    yield {
      severity: 'warn',
      code: 'invariant.missing_user_event',
      path: '/',
      message: `Missing: ${missing.join(' and ')}. codex-rs/rollout/src/list.rs requires BOTH for the resume picker to show this file.`,
    }
  }
}

// ---------------------------------------------------------------------
// Public entry point. Order of invariants doesn't matter — they all
// read the stream, none mutate it, and the report aggregator dedups on
// (line, code, path) so accidental overlaps wouldn't double-report.
// ---------------------------------------------------------------------
export function runInvariants(
  lines: readonly unknown[],
): ValidationIssue[] {
  const out: ValidationIssue[] = []
  for (const gen of [
    checkLocalShellEnv,
    checkFunctionCallArgumentsJson,
    checkCallIdPairing,
    checkSessionMetaOrdering,
    checkSawUserEvent,
  ]) {
    for (const issue of gen(lines)) out.push(issue)
  }
  return out
}

import { describe, expect, it } from 'vitest'

import { projectCodexNativeResume } from '../../src/v2/codex/project/nativeResume.js'
import type { ConversationDocument } from '../../src/v2/conversation/types.js'
import { validateRollout } from '../codex-validator/src/validate.js'

const sourceCommit = '8035cb03f1a5061d0342cb8fa3a10a18068ca683'
const timestamp = '2026-07-20T12:00:00.000Z'

describe(`Codex native-resume source contract at ${sourceCommit.slice(0, 8)}`, () => {
  it('accepts the discoverable rollout emitted by the pinned profile', () => {
    const result = projectCodexNativeResume(conversation(), options())
    const validation = validateRollout(result.values)

    expect(result.providerProfile.evidence.sourceCommit).toBe(sourceCommit)
    expect(validation).toMatchObject({ ok: true, errorCount: 0, warnCount: 0 })
  })

  it('rejects content placed before session metadata', () => {
    const values = projectCodexNativeResume(conversation(), options()).values
    const [metadata, ...content] = values
    const validation = validateRollout([...content, metadata])

    // WHY this is a source-contract failure rather than a formatting opinion:
    // pinned codex-rs resume discovery scans early rollout lines for metadata.
    // A late session_meta can be perfectly valid JSON while remaining
    // invisible to the provider's session picker.
    expect(validation.ok).toBe(false)
    expect(validation.issues.map(issue => issue.code)).toContain(
      'invariant.session_meta_late',
    )
  })

  it('rejects an orphaned tool result that native normalization would mutate', () => {
    const values = projectCodexNativeResume(conversation(), options()).values
    const callIndex = values.findIndex(value => (
      value.type === 'response_item' &&
      isRecord(value.payload) &&
      value.payload.type === 'function_call'
    ))
    expect(callIndex).toBeGreaterThan(-1)
    const validation = validateRollout(values.filter((_, index) => index !== callIndex))

    // WHY the gate fails instead of trusting Codex to repair the history:
    // native normalization may drop or synthesize tool plumbing, which changes
    // the conversation the user intended to resume.
    expect(validation.ok).toBe(false)
    expect(validation.issues.map(issue => issue.code)).toContain(
      'invariant.orphaned_tool_output',
    )
  })
})

function conversation(): ConversationDocument {
  return {
    schemaVersion: 1,
    sourceProvider: 'claude',
    sourceSessionIds: ['source-session'],
    entries: [
      {
        kind: 'message',
        role: 'user',
        content: [{ kind: 'text', text: 'source contract prompt' }],
        timestamp,
        source: { provider: 'claude', line: 0, raw: {}, evidence: [] },
      },
      {
        kind: 'tool-call',
        callId: 'source-contract-call',
        name: 'Read',
        input: { path: '/fixture/file' },
        nativeKind: 'tool_use',
        timestamp,
        source: { provider: 'claude', line: 1, raw: {}, evidence: [] },
      },
      {
        kind: 'tool-result',
        callId: 'source-contract-call',
        output: 'fixture output',
        isError: false,
        nativeKind: 'tool_result',
        timestamp,
        source: { provider: 'claude', line: 2, raw: {}, evidence: [] },
      },
    ],
  }
}

function options() {
  return {
    targetSessionId: '00000000-0000-4000-8000-000000000803',
    now: timestamp,
    cwd: '/fixture/project',
    cliVersion: '0.144.6',
    modelProvider: 'openai',
    model: 'gpt-5',
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

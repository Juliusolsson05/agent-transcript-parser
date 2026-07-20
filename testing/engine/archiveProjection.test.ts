import { describe, expect, it } from 'vitest'

import { classifyClaudeRecord } from '../../src/claude/classify/classify.js'
import { decodeClaudeConversation } from '../../src/claude/conversation/decode.js'
import { claudeArchiveProjector, projectClaudeArchive } from '../../src/claude/project/index.js'
import { classifyCodexRecord } from '../../src/codex/classify/classify.js'
import { decodeCodexConversation } from '../../src/codex/conversation/decode.js'
import { codexArchiveProjector, projectCodexArchive } from '../../src/codex/project/index.js'
import type { ConversationDocument, ConversationEntry } from '../../src/conversation/types.js'
import type { ArchiveProjector } from '../../src/projection/types.js'

const now = '2026-07-20T12:00:00.000Z'

describe('provider-independent archive projection', () => {
  it('exposes independent projectors through the same open provider contract', () => {
    const projectors: ArchiveProjector[] = [claudeArchiveProjector, codexArchiveProjector]
    expect(projectors.map(projector => projector.provider)).toEqual(['claude', 'codex'])
  })

  it('projects the neutral protocol into Codex without importing Claude shapes', () => {
    const result = projectCodexArchive(conversation('fixture-source'), {
      targetSessionId: 'codex-target',
      now,
    })

    expect(result.profile).toBe('archive')
    expect(result.targetProvider).toBe('codex')
    expect(result.values[0]).toEqual({
      timestamp: now,
      type: 'session_meta',
      payload: {
        id: 'codex-target',
        timestamp: now,
        source: 'agent-transcript-parser-archive',
        originator: 'agent-transcript-parser',
      },
    })
    expect(result.values.map(value => value.type)).toEqual([
      'session_meta',
      'response_item',
      'response_item',
      'response_item',
      'response_item',
      'compacted',
      'atp_archive',
    ])
    expect(result.values[2]?.payload).toMatchObject({
      type: 'function_call',
      call_id: 'call-1',
      name: 'Read',
    })
    expect(result.values[3]?.payload).toMatchObject({
      type: 'function_call_output',
      call_id: 'call-1',
    })
    expect(result.report.changes).toHaveLength(7)
    expect(result.report.counts.synthesized).toBe(1)
    expect(result.report.counts.opaque).toBe(1)
    expect(result.report.counts.dropped).toBe(0)
  })

  it('projects the neutral protocol into a deterministic Claude parent chain', () => {
    const result = projectClaudeArchive(conversation('fixture-source'), {
      targetSessionId: 'claude-target',
      now,
      idFactory: seed => `id:${seed}`,
    })

    expect(result.profile).toBe('archive')
    expect(result.targetProvider).toBe('claude')
    expect(result.values.map(value => value.type)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'system',
      'atp_archive',
    ])
    expect(result.values.map(value => value.uuid)).toEqual([
      'id:claude-target:archive:0',
      'id:claude-target:archive:1',
      'id:claude-target:archive:2',
      'id:claude-target:archive:3',
      'id:claude-target:archive:4',
      'id:claude-target:archive:5',
    ])
    expect(result.values.map(value => value.parentUuid)).toEqual([
      null,
      'id:claude-target:archive:0',
      'id:claude-target:archive:1',
      'id:claude-target:archive:2',
      'id:claude-target:archive:3',
      'id:claude-target:archive:4',
    ])
    expect(result.values[1]?.message).toMatchObject({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call-1', name: 'Read' }],
    })
    expect(result.values[2]?.message).toMatchObject({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call-1' }],
    })
    expect(result.report.changes).toHaveLength(6)
    expect(result.report.counts.opaque).toBe(1)
    expect(result.report.counts.dropped).toBe(0)
  })

  it('preserves same-provider raw records once when one record decoded into several semantic entries', () => {
    const raw = {
      timestamp: now,
      type: 'response_item',
      payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'kept' }] },
      future_field: { kept: true },
    }
    const source = sourceEntry('reasoning', 9, raw)
    const duplicateSource = sourceEntry('opaque', 9, raw)
    const document: ConversationDocument = {
      schemaVersion: 1,
      sourceProvider: 'codex',
      sourceSessionIds: ['old'],
      entries: [source, duplicateSource],
    }

    const result = projectCodexArchive(document, { targetSessionId: 'new', now })
    expect(result.values).toEqual([
      {
        timestamp: now,
        type: 'session_meta',
        payload: {
          id: 'new',
          timestamp: now,
          source: 'agent-transcript-parser-archive',
          originator: 'agent-transcript-parser',
        },
      },
      raw,
    ])
    expect(result.report.changes.map(change => change.code)).toEqual([
      'archive.session-meta.synthesized',
      'archive.same-provider.raw-preserved',
    ])
  })

  it('bounds opaque provenance instead of recursively embedding prior archives', () => {
    const document = conversation('fixture-source')
    const opaque = document.entries.at(-1)
    if (opaque) {
      opaque.source.raw = {
        type: 'future',
        large: 'x'.repeat(512),
        atp_archive: { source: { recursive: 'must disappear' } },
      }
    }
    const result = projectCodexArchive(document, {
      targetSessionId: 'target',
      now,
      maxEmbeddedSourceBytes: 64,
    })
    const archive = result.values.at(-1)?.payload
    expect(archive).toMatchObject({ source_omitted: true })
    expect(archive).not.toHaveProperty('source')
  })

  it('keeps repeated cross-provider archives flat and record-count stable', () => {
    let document = conversation('claude')
    const sizes: number[] = []
    const counts: number[] = []

    for (let iteration = 0; iteration < 6; iteration += 1) {
      const codex = projectCodexArchive(document, { targetSessionId: 'codex-target', now })
      sizes.push(JSON.stringify(codex.values).length)
      counts.push(codex.values.length)
      document = decodeCodexConversation(codex.values.map((value, line) => classifyCodexRecord(value, line)))

      const claude = projectClaudeArchive(document, {
        targetSessionId: 'claude-target',
        now,
        idFactory: seed => `id:${seed}`,
      })
      document = decodeClaudeConversation(claude.values.map((value, line) => classifyClaudeRecord(value, line)))
    }

    expect(new Set(counts)).toEqual(new Set([7]))
    expect(new Set(sizes).size).toBe(1)
    const provenanceMarkers = JSON.stringify(document).match(/source_provider/g) ?? []
    expect(provenanceMarkers.length).toBeLessThanOrEqual(document.entries.length)
  })
})

function conversation(sourceProvider: string): ConversationDocument {
  return {
    schemaVersion: 1,
    sourceProvider,
    sourceSessionIds: ['source-session'],
    entries: [
      {
        kind: 'message',
        role: 'user',
        content: [{ kind: 'text', text: 'hello' }],
        ...source(0, { type: 'source-message' }, sourceProvider),
      },
      {
        kind: 'tool-call',
        callId: 'call-1',
        name: 'Read',
        input: { path: '/fixture/file' },
        nativeKind: 'fixture-call',
        ...source(1, { type: 'source-call' }, sourceProvider),
      },
      {
        kind: 'tool-result',
        callId: 'call-1',
        output: { text: 'result' },
        isError: false,
        nativeKind: 'fixture-result',
        ...source(2, { type: 'source-result' }, sourceProvider),
      },
      {
        kind: 'reasoning',
        text: 'reasoning',
        encrypted: 'ciphertext',
        ...source(3, { type: 'source-reasoning' }, sourceProvider),
      },
      {
        kind: 'compaction',
        summary: 'summary',
        ...source(4, { type: 'source-compaction' }, sourceProvider),
      },
      {
        kind: 'opaque',
        nativeType: 'future-record',
        ...source(5, { type: 'future-record', value: 'kept in provenance' }, sourceProvider),
      },
    ],
  }
}

function source(
  line: number,
  raw: Record<string, unknown>,
  provider: string,
): Pick<ConversationEntry, 'timestamp' | 'source'> {
  return { timestamp: now, source: { provider, line, raw, evidence: [] } }
}

function sourceEntry(
  kind: 'reasoning' | 'opaque',
  line: number,
  raw: Record<string, unknown>,
): ConversationEntry {
  const base = source(line, raw, 'codex')
  return kind === 'reasoning'
    ? { kind, text: 'kept', encrypted: null, ...base }
    : { kind, nativeType: 'reasoning-shadow', ...base }
}

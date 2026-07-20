import { describe, expect, it } from 'vitest'

import {
  createGhost,
  ghostUuid,
  isGhostUuid,
  mergeWithUpstream,
  orphanGhost,
  reduceGhostLog,
  reduceGhostLogSansSuperseded,
  supersedeGhost,
  updateGhost,
} from '../src/ghost.js'
import { ghostSidecar, isGhost, readSidecar, stripSidecar } from '../src/ghost-sidecar.js'
import type { ClaudeEntry, GhostEntry } from '../src/ghost-sidecar.js'

// Ghost is deliberately frozen during the transcript-engine rewrite. These
// tests characterize its existing public behavior at the boundary consumed by
// Agent Code; the neutral conversation model must not absorb or reinterpret this
// provisional live-state ledger until those host invariants are redesigned.
describe('frozen ghost contract', () => {
  it('uses a deterministic identity and rejects ambiguous coordinates', () => {
    expect(ghostUuid('turn', 3)).toBe('g-turn-3')
    expect(isGhostUuid('g-turn-3')).toBe(true)
    expect(isGhostUuid('00000000-0000-4000-8000-000000000001')).toBe(false)
    expect(() => ghostUuid('', 0)).toThrow('turnId is required')
    expect(() => ghostUuid('turn', Number.NaN)).toThrow('finite number')
  })

  it('keeps lifecycle updates immutable and preserves consumer context', () => {
    const created = fixtureGhost('turn', 0, 100, 'a')
    const updated = updateGhost(created, [{ type: 'text', text: 'ab' }], 110)
    const superseded = supersedeGhost(updated, 'real-entry', 120)
    const orphaned = orphanGhost(updated, 130)

    expect(created.message?.content).toEqual([{ type: 'text', text: 'a' }])
    expect(updated).not.toBe(created)
    expect(updated).toMatchObject({
      uuid: created.uuid,
      timestamp: new Date(110).toISOString(),
      _atp: {
        createdAt: 100,
        updatedAt: 110,
        context: { source: 'contract' },
      },
    })
    expect(superseded._atp).toMatchObject({ updatedAt: 120, supersededBy: 'real-entry' })
    expect(orphaned._atp).toMatchObject({ updatedAt: 130, orphanedAt: 130 })
    expect(updated._atp).not.toHaveProperty('supersededBy')
    expect(updated._atp).not.toHaveProperty('orphanedAt')
  })

  it('reduces append-only snapshots by updatedAt with later-stream tie breaking', () => {
    const first = fixtureGhost('turn', 0, 100, 'first')
    const stale = updateGhost(first, [{ type: 'text', text: 'stale' }], 90)
    const tied = updateGhost(first, [{ type: 'text', text: 'tie wins' }], 100)
    const other = fixtureGhost('other', 0, 95, 'other')
    const ordinary = { type: 'user', uuid: 'real' } as ClaudeEntry

    const reduced = reduceGhostLog([first, stale, ordinary, tied, other])
    expect([...reduced.keys()]).toEqual([first.uuid, other.uuid])
    expect(reduced.get(first.uuid)?.message?.content).toEqual([
      { type: 'text', text: 'tie wins' },
    ])
  })

  it('offers a resume reader that drops only finally-superseded ghosts', () => {
    const live = fixtureGhost('live', 0, 100, 'live')
    const orphaned = orphanGhost(fixtureGhost('orphan', 0, 100, 'orphan'), 110)
    const superseded = supersedeGhost(fixtureGhost('done', 0, 100, 'done'), 'real', 120)
    const reduced = reduceGhostLogSansSuperseded([live, orphaned, superseded])

    expect([...reduced.keys()]).toEqual([live.uuid, orphaned.uuid])
  })

  it('merges authoritative history first and orders the provisional tail deterministically', () => {
    const upstream = [{ uuid: 'real-1' }, { uuid: 'real-2' }]
    const laterBlock = fixtureGhost('same-turn', 1, 200, 'block 1')
    const earlierBlock = fixtureGhost('same-turn', 0, 200, 'block 0')
    const earlierTurn = fixtureGhost('a-turn', 0, 200, 'earlier turn id')
    const superseded = supersedeGhost(
      fixtureGhost('done', 0, 100, 'done'),
      'real-2',
      150,
    )
    const ghosts = new Map([
      [laterBlock.uuid, laterBlock],
      [superseded.uuid, superseded],
      [earlierBlock.uuid, earlierBlock],
      [earlierTurn.uuid, earlierTurn],
    ])

    expect(mergeWithUpstream(upstream, ghosts).map(entry => entry.uuid)).toEqual([
      'real-1',
      'real-2',
      earlierTurn.uuid,
      earlierBlock.uuid,
      laterBlock.uuid,
    ])
  })

  it('keeps the documented recent-tail and forensic supersedence policies distinct', () => {
    const ghost = supersedeGhost(
      fixtureGhost('done', 0, 100, 'done'),
      'outside-loaded-tail',
      110,
    )
    const ghosts = new Map([[ghost.uuid, ghost]])

    // Default mode keeps the provisional evidence if its claimed replacement
    // is not visible. Recent-tail consumers explicitly trust the persisted
    // flag, while forensic mode wins if both switches are accidentally set.
    expect(mergeWithUpstream([], ghosts)).toEqual([ghost])
    expect(mergeWithUpstream([], ghosts, { trustSupersededFlag: true })).toEqual([])
    expect(mergeWithUpstream([], ghosts, {
      trustSupersededFlag: true,
      keepSupersededGhosts: true,
    })).toEqual([ghost])
  })

  it('validates the sidecar strictly and strips it without mutating the record', () => {
    const ghost = fixtureGhost('turn', 0, 100, 'text')
    expect(isGhost(ghost)).toBe(true)
    expect(ghostSidecar(ghost)).toEqual(ghost._atp)
    expect(readSidecar({ _atp: { origin: 'ghost', turnId: 'turn' } })).toBeNull()

    const stripped = stripSidecar(ghost)
    expect(stripped).not.toBe(ghost)
    expect(stripped).not.toHaveProperty('_atp')
    expect(ghost).toHaveProperty('_atp')
  })

})

function fixtureGhost(
  turnId: string,
  blockIndex: number,
  now: number,
  text: string,
): GhostEntry {
  return createGhost({
    sessionId: 'session',
    turnId,
    blockIndex,
    role: 'assistant',
    content: [{ type: 'text', text }],
    context: { source: 'contract' },
    now,
  })
}

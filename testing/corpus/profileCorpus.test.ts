import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { profileCorpus } from './profileCorpus.js'

describe('profileCorpus', () => {
  it('writes aggregate structure without retaining private values or paths', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'atp-v2-profile-'))
    const claudeRoot = join(temporary, 'private-provider-home')
    const projectDir = join(claudeRoot, '-Users-private-secret-repository')
    const outputPath = join(temporary, 'output', 'profile.json')
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      join(projectDir, 'private-session-id.jsonl'),
      `${JSON.stringify({
        type: 'user',
        sessionId: 'PRIVATE_SESSION_9382',
        cwd: '/Users/private/secret-repository',
        message: { role: 'user', content: 'PRIVATE_PROMPT_8472' },
      })}\n`,
      'utf8',
    )

    const profile = await profileCorpus({
      claudeRoot,
      outputPath,
      generatedAt: '2026-07-20T00:00:00.000Z',
    })
    const serialized = await readFile(outputPath, 'utf8')

    expect(profile.summary.files).toBe(1)
    expect(profile.summary.records).toBe(1)
    expect(profile.categories['claude-main'].files).toBe(1)
    expect(serialized).not.toContain('PRIVATE_SESSION_9382')
    expect(serialized).not.toContain('PRIVATE_PROMPT_8472')
    expect(serialized).not.toContain('/Users/private')
    expect(serialized).not.toContain('private-session-id')
    expect(serialized).not.toContain('private-provider-home')
  })

  it('refuses to write inside a provider transcript root', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'atp-v2-profile-boundary-'))
    const claudeRoot = join(temporary, 'claude')
    await mkdir(claudeRoot, { recursive: true })

    await expect(profileCorpus({
      claudeRoot,
      outputPath: join(claudeRoot, 'profile.json'),
    })).rejects.toThrow('must not be written inside a provider transcript root')
  })
})

import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import * as pty from 'node-pty'
import { describe, expect, it } from 'vitest'

import { projectClaudeNativeResume } from '../../src/v2/claude/project/nativeResume.js'
import type { ConversationDocument } from '../../src/v2/conversation/types.js'

const enabled = process.env.ATP_RUN_NATIVE_CLAUDE === '1'
const claudeBinary = process.env.ATP_CLAUDE_BIN ?? 'claude'

describe.skipIf(!enabled)('controlled Claude native-resume compatibility', () => {
  it('loads and renders projected history in the installed interactive CLI', async () => {
    const versionResult = spawnSync(claudeBinary, ['--version'], { encoding: 'utf8' })
    expect(versionResult.status, versionResult.stderr).toBe(0)
    const version = versionResult.stdout.trim().split(/\s+/)[0] ?? 'unknown'
    const cwd = await mkdtemp(join(tmpdir(), 'atp-claude-resume-'))
    // WHY storage uses the canonical path while the PTY may accept its alias:
    // macOS exposes /var as a symlink to /private/var, and Claude realpaths the
    // workspace before deriving ~/.claude/projects/<sanitized-cwd>. Writing
    // under the pre-realpath key creates a plausible directory that Claude can
    // never discover.
    const canonicalCwd = (await realpath(cwd)).normalize('NFC')
    const sessionId = '00000000-0000-4000-8000-000000000215'
    const now = '2026-07-20T12:00:00.000Z'
    const configRoot = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
    const projectDir = join(configRoot, 'projects', sanitizePath(canonicalCwd))
    const sessionPath = join(projectDir, `${sessionId}.jsonl`)
    const projection = projectClaudeNativeResume(conversation(now), {
      targetSessionId: sessionId,
      now,
      cwd: canonicalCwd,
      version,
      model: 'claude-sonnet-4-6',
    })
    await mkdir(projectDir, { recursive: true })
    await writeFile(
      sessionPath,
      `${projection.values.map(value => JSON.stringify(value)).join('\n')}\n`,
      'utf8',
    )

    // Claude has no local app-server reconstruction RPC equivalent. The
    // strongest network-free check is therefore its real interactive resume
    // path: open a PTY without submitting a prompt and require both projected
    // turns to appear. The test uses a unique cwd/session and removes only the
    // project directory it created after the CLI exits.
    const terminal = pty.spawn(claudeBinary, [
      '--resume',
      sessionId,
      '--safe-mode',
      '--permission-mode',
      'dontAsk',
    ], {
      name: 'xterm-256color',
      cols: 160,
      rows: 50,
      cwd,
      env: process.env as Record<string, string>,
    })

    try {
      const output = await waitForHistory(terminal)
      expect(output).toContain('ATP_CLAUDE_PROMPT_215')
      expect(output).toContain('ATP_CLAUDE_ANSWER_215')
    } finally {
      terminal.kill()
      await rm(projectDir, { recursive: true, force: true })
      await rm(cwd, { recursive: true, force: true })
    }
  }, 30_000)
})

function conversation(now: string): ConversationDocument {
  return {
    schemaVersion: 1,
    sourceProvider: 'codex',
    sourceSessionIds: ['fixture-source'],
    entries: [
      message('user', 'ATP_CLAUDE_PROMPT_215', 0, now),
      message('assistant', 'ATP_CLAUDE_ANSWER_215', 1, now),
    ],
  }
}

function message(
  role: 'user' | 'assistant',
  text: string,
  line: number,
  timestamp: string,
): ConversationDocument['entries'][number] {
  return {
    kind: 'message',
    role,
    content: [{ kind: 'text', text }],
    timestamp,
    source: { provider: 'codex', line, raw: {}, evidence: [] },
  }
}

function sanitizePath(value: string): string {
  return value.normalize('NFC').replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200)
}

function waitForHistory(terminal: pty.IPty): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = ''
    let trustConfirmed = false
    const timeout = setTimeout(() => {
      subscription.dispose()
      reject(new Error(`Claude did not render projected history. Screen output: ${output.slice(-2000)}`))
    }, 15_000)
    const subscription = terminal.onData(chunk => {
      output += chunk
      if (
        !trustConfirmed &&
        output.includes('Quick') &&
        output.includes('safety') &&
        output.includes('folder')
      ) {
        // The probe directory was created by this test and contains only the
        // projected fixture, so selecting Claude's already-highlighted "Yes"
        // option does not weaken trust for any real repository. Claude stores
        // the decision under this one throwaway sanitized cwd, which cleanup
        // removes together with the projected session file.
        trustConfirmed = true
        terminal.write('\r')
      }
      if (
        output.includes('ATP_CLAUDE_PROMPT_215') &&
        output.includes('ATP_CLAUDE_ANSWER_215')
      ) {
        clearTimeout(timeout)
        subscription.dispose()
        resolve(output)
      }
    })
  })
}

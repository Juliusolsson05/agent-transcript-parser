import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as pty from 'node-pty'
import { describe, expect, it } from 'vitest'

import { projectClaudeNativeResume } from '../../src/claude/project/nativeResume.js'
import type { ConversationDocument } from '../../src/conversation/types.js'

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
    // WHY a throwaway CLAUDE_CONFIG_DIR instead of the developer's real ~/.claude (agent-code#1295):
    // this probe only renders a resumed history, so it needs no login and no network. Pointing it at
    // the real home wrote the session under ~/.claude/projects and, worse, recorded the folder-trust
    // decision in the real ~/.claude.json `projects` map, which cleanup can never remove (six stale
    // atp-claude-resume-* entries were found there on 2026-09-26). With a private config dir the
    // real login is not even reachable: on macOS Claude keys its keychain entry by config dir.
    const configRoot = await mkdtemp(join(tmpdir(), 'atp-claude-config-'))
    // Pre-seed what the interactive CLI otherwise stops to ask (vendor claude-code-src
    // interactiveHelpers.tsx showSetupScreens): onboarding needs a theme plus
    // hasCompletedOnboarding, and trust is looked up by the realpath'd cwd.
    await writeFile(join(configRoot, '.claude.json'), JSON.stringify({
      theme: 'dark',
      hasCompletedOnboarding: true,
      projects: { [canonicalCwd]: { hasTrustDialogAccepted: true } },
    }), { mode: 0o600 })
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
      env: claudeProbeEnv(configRoot),
    })

    // WHY cleanup waits for the CLI to exit: Claude saves its global config
    // (plus a backups/ copy) from its shutdown handler AFTER the kill signal.
    // Removing the config dir right after kill() raced that save and left a
    // recreated atp-claude-config-* dir behind (observed on the first run).
    const exited = new Promise<void>(resolveExit => {
      terminal.onExit(() => resolveExit())
    })

    try {
      const output = await waitForHistory(terminal)
      expect(output).toContain('ATP_CLAUDE_PROMPT_215')
      expect(output).toContain('ATP_CLAUDE_ANSWER_215')
    } finally {
      terminal.kill()
      const forceKill = setTimeout(() => terminal.kill('SIGKILL'), 5_000)
      await exited
      clearTimeout(forceKill)
      // Everything the CLI wrote lives under these two throwaway roots.
      await rm(configRoot, { recursive: true, force: true })
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

/**
 * The parent environment minus every way Claude could pick up a real credential or real state.
 *
 * WHY strip instead of passing process.env through: an inherited ANTHROPIC_API_KEY (or OAuth token
 * env) would both put a real credential in reach of the probe and raise Claude's "use this API
 * key?" dialog, which this network-free probe has no reason to answer.
 */
function claudeProbeEnv(configRoot: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (/^(ANTHROPIC_|CLAUDE_CODE_OAUTH|CLAUDE_CONFIG_DIR$)/.test(key)) continue
    env[key] = value
  }
  env.CLAUDE_CONFIG_DIR = configRoot
  // A fresh config dir would otherwise let this probe start an auto-update of the real install.
  env.DISABLE_AUTOUPDATER = '1'
  return env
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
        // Fallback only: the seeded config already trusts the probe cwd. If a
        // future Claude keys trust differently, the dialog appears; accepting
        // it is harmless because the decision now lands in the throwaway
        // CLAUDE_CONFIG_DIR (never the real ~/.claude.json), which cleanup
        // removes, and the probe directory holds only the projected fixture.
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

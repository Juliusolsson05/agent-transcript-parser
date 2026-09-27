import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

import * as pty from 'node-pty'
import { describe, expect, it } from 'vitest'

import { projectClaudeNativeResume } from '../../src/claude/project/nativeResume.js'
import type { ConversationDocument } from '../../src/conversation/types.js'
import { assertNoMachinePolicy, createClaudeProbe } from './claudeProbeLaunch.js'

const enabled = process.env.ATP_RUN_NATIVE_CLAUDE === '1'
const claudeBinary = process.env.ATP_CLAUDE_BIN ?? 'claude'

describe.skipIf(!enabled)('controlled Claude native-resume compatibility', () => {
  it('loads and renders projected history in the installed interactive CLI', async () => {
    const sessionId = '00000000-0000-4000-8000-000000000215'
    const now = '2026-07-20T12:00:00.000Z'
    // WHY one throwaway root holding the workspace, CLAUDE_CONFIG_DIR and HOME
    // (agent-code#1295): this probe only renders a resumed history, so it needs
    // no login and no network. Pointing it at the real home wrote the session
    // under ~/.claude/projects and, worse, recorded the folder-trust decision
    // in the real ~/.claude.json `projects` map, which cleanup can never remove
    // (six stale atp-claude-resume-* entries were found there on 2026-09-26).
    // The launch policy (allowlisted env, --bare) is in claudeProbeLaunch.ts
    // and pinned by claudeProbeLaunch.test.ts. One root means one rm owns every
    // byte the probe or the CLI writes, from the first mkdtemp on.
    // Before creating anything: a machine policy can run commands that no
    // throwaway root contains (see managedPolicySources).
    assertNoMachinePolicy(process.platform, userInfo().username, existsSync)
    const probeRoot = await mkdtemp(join(tmpdir(), 'atp-claude-probe-'))
    let stopped: 'exited' | 'killed' | 'stuck' | 'never-spawned' = 'never-spawned'
    let canary: string | undefined
    let helperRan = false
    try {
      const cwd = join(probeRoot, 'workspace')
      const configRoot = join(probeRoot, 'config')
      const home = join(probeRoot, 'home')
      const tmp = join(probeRoot, 'tmp')
      await Promise.all([cwd, configRoot, home, tmp].map(dir => mkdir(dir, { mode: 0o700 })))
      // Every launch goes through the probe, which builds the allowlisted env
      // itself: this file never holds an env it could widen (review of #37).
      const probe = createClaudeProbe(claudeBinary, process.env, { configRoot, home, tmp }, {
        spawnSync: (binary, args, options) => spawnSync(binary, args, options),
        spawnPty: (binary, args, options) => pty.spawn(binary, args, options),
      })
      const versionResult = probe.version()
      expect(versionResult.status, versionResult.stderr).toBe(0)
      const version = versionResult.stdout.trim().split(/\s+/)[0] ?? 'unknown'
      // WHY storage uses the canonical path while the PTY may accept its alias:
      // macOS exposes /var as a symlink to /private/var, and Claude realpaths the
      // workspace before deriving <config>/projects/<sanitized-cwd>. Writing
      // under the pre-realpath key creates a plausible directory that Claude can
      // never discover.
      const canonicalCwd = (await realpath(cwd)).normalize('NFC')
      // Pre-seed what the interactive CLI otherwise stops to ask (vendor
      // claude-code-src interactiveHelpers.tsx showSetupScreens): onboarding
      // needs a theme plus hasCompletedOnboarding, and trust is looked up by the
      // realpath'd cwd.
      await writeFile(join(configRoot, '.claude.json'), JSON.stringify({
        theme: 'dark',
        hasCompletedOnboarding: true,
        projects: { [canonicalCwd]: { hasTrustDialogAccepted: true } },
      }), { mode: 0o600 })
      // Canary for the --bare boundary (steering q44): a machine-policy
      // apiKeyHelper cannot be planted from a test, but a USER-settings one
      // takes the same path — outside bare mode getConfiguredApiKeyHelper()
      // returns the merged settings' helper and startup executes it before any
      // prompt; in bare mode only --settings flag settings count. If this
      // marker appears, a real policy helper would have run too. Verified
      // 2026-09-26 on Claude Code 2.1.283: without --bare the marker is
      // created; with it, never.
      const helperMarker = join(probeRoot, 'api-key-helper-ran')
      await writeFile(join(configRoot, 'settings.json'), JSON.stringify({
        apiKeyHelper: `/usr/bin/touch '${helperMarker}'`,
      }), { mode: 0o600 })
      canary = helperMarker
      const projectDir = join(configRoot, 'projects', sanitizePath(canonicalCwd))
      const projection = projectClaudeNativeResume(conversation(now), {
        targetSessionId: sessionId,
        now,
        cwd: canonicalCwd,
        version,
        model: 'claude-sonnet-4-6',
      })
      await mkdir(projectDir, { recursive: true })
      await writeFile(
        join(projectDir, `${sessionId}.jsonl`),
        `${projection.values.map(value => JSON.stringify(value)).join('\n')}\n`,
        'utf8',
      )

      // Claude has no local app-server reconstruction RPC equivalent. The
      // strongest network-free check is therefore its real interactive resume
      // path: open a PTY without submitting a prompt and require both projected
      // turns to appear.
      const run = await probe.withTerminal(sessionId, cwd, async terminal => {
        const output = await waitForHistory(terminal)
        expect(output).toContain('ATP_CLAUDE_PROMPT_215')
        expect(output).toContain('ATP_CLAUDE_ANSWER_215')
      })
      stopped = run.stopped
      if (run.error !== undefined) throw run.error
    } finally {
      if (canary !== undefined) helperRan = existsSync(canary)
      await rm(probeRoot, { recursive: true, force: true })
    }
    // A CLI that outlived SIGKILL may still be writing; say so instead of
    // letting the green run imply a clean footprint.
    expect(helperRan, 'apiKeyHelper executed: the --bare boundary is broken').toBe(false)
    expect(stopped).not.toBe('stuck')
    expect(existsSync(probeRoot), 'probe root removed').toBe(false)
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
        // Fallback only: the seeded config already trusts the probe cwd. If a
        // future Claude keys trust differently, the dialog appears; accepting
        // it is harmless because the decision lands in the throwaway
        // CLAUDE_CONFIG_DIR (never the real ~/.claude.json), which cleanup
        // removes, and the workspace holds nothing but the probe.
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

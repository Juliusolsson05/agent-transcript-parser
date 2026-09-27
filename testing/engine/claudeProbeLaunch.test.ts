import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { PROBE_ENV_ALLOWLIST, assertNoMachinePolicy, claudeProbeArgs, claudeProbeEnv, createClaudeProbe, managedPolicySources, watchExit } from './claudeProbeLaunch.js'

// WHY a deterministic test for a live probe's launch policy (agent-code#1295,
// steering q44): the live probe is opt-in and skipped everywhere else, so its
// "no real credential reaches the child" rule would otherwise be checked by
// nobody. These cases pin that rule and the bounded exit without Claude.

const roots = { configRoot: '/probe/config', home: '/probe/home', tmp: '/probe/tmp' }

// Every credential route the review of agent-transcript-parser#37 traced to a
// Claude startup path, plus the ones the first version already stripped. The
// values are fixture-only; the names are what matter.
const HOSTILE_PARENT: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin',
  TERM: 'xterm-256color',
  LANG: 'en_US.UTF-8',
  TMPDIR: '/var/folders/real/T/',
  HOME: '/Users/real-developer',
  USER: 'real-developer',
  ANTHROPIC_API_KEY: 'fixture-anthropic-key',
  ANTHROPIC_AUTH_TOKEN: 'fixture-auth-token',
  CLAUDE_CODE_OAUTH_TOKEN: 'fixture-oauth',
  CLAUDE_CONFIG_DIR: '/Users/real-developer/.claude',
  CLAUDE_CODE_USE_BEDROCK: '1',
  AWS_BEARER_TOKEN_BEDROCK: 'fixture-bedrock-token',
  AWS_PROFILE: 'real-profile',
  AWS_ACCESS_KEY_ID: 'fixture-access-key',
  AWS_SECRET_ACCESS_KEY: 'fixture-secret',
  CLAUDE_CODE_USE_VERTEX: '1',
  GOOGLE_APPLICATION_CREDENTIALS: '/Users/real-developer/gcp.json',
  CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: '3',
  CLAUDE_CODE_USE_FOUNDRY: '1',
  HTTPS_PROXY: 'http://user:pass@proxy.example',
  SOME_FUTURE_PROVIDER_TOKEN: 'fixture-future',
}

describe('Claude probe launch policy', () => {
  it('passes nothing from the parent but the allowlist, and points every home at the throwaway roots', () => {
    const env = claudeProbeEnv(HOSTILE_PARENT, roots)
    const inherited = Object.keys(env).filter(key => env[key] === HOSTILE_PARENT[key])
    expect(inherited.sort()).toEqual(['LANG', 'PATH', 'TERM'])
    expect(inherited.every(key => PROBE_ENV_ALLOWLIST.includes(key))).toBe(true)
    expect(env).toEqual({
      PATH: '/usr/bin:/bin',
      TERM: 'xterm-256color',
      LANG: 'en_US.UTF-8',
      HOME: '/probe/home',
      TMPDIR: '/probe/tmp',
      CLAUDE_CONFIG_DIR: '/probe/config',
      CLAUDE_CODE_SIMPLE: '1',
      DISABLE_AUTOUPDATER: '1',
    })
    // No value from the hostile parent leaks under ANY key.
    const leaked = Object.values(env).filter(value => /fixture|real-developer|real-profile|proxy\.example/.test(value))
    expect(leaked).toEqual([])
  })

  // Review round 2 of #37: adding a credential name to the allowlist passed the
  // env test whenever the hostile fixture happened not to contain that name. So
  // the allowlist itself is pinned, and no entry may look like a credential.
  it('allowlists only terminal and locale variables, none of which can carry a credential', () => {
    expect([...PROBE_ENV_ALLOWLIST].sort()).toEqual(['LANG', 'LC_ALL', 'LC_CTYPE', 'PATH', 'TERM'])
    for (const key of PROBE_ENV_ALLOWLIST) {
      expect(key).not.toMatch(/TOKEN|KEY|SECRET|CREDENTIAL|PASSWORD|AUTH|PROFILE|PROXY|AWS|GOOGLE|ANTHROPIC|CLAUDE|HOME|DIR/)
    }
  })

  it('refuses to launch when any machine-policy source exists, and on Windows', () => {
    const policyFile = '/Library/Application Support/ClaudeCode/managed-settings.json'
    expect(managedPolicySources('darwin', 'dev', () => false)).toEqual([])
    expect(managedPolicySources('darwin', 'dev', path => path === policyFile)).toEqual([policyFile])
    expect(managedPolicySources('darwin', 'dev', path => path === '/Library/Managed Preferences/dev/com.anthropic.claudecode.plist'))
      .toHaveLength(1)
    expect(managedPolicySources('darwin', 'dev', path => path.endsWith('managed-settings.d'))).toHaveLength(1)
    expect(managedPolicySources('linux', 'dev', path => path === '/etc/claude-code/managed-settings.json')).toHaveLength(1)
    expect(managedPolicySources('linux', 'dev', () => false)).toEqual([])
    expect(managedPolicySources('win32', 'dev', () => false)).toHaveLength(1)
  })

  // Steering q50: the policy-command canary. A machine policy that sets
  // `statusLine: {type:'command', command: ...}` runs that command when the
  // prompt footer mounts, even under --bare. The probe's gate must refuse
  // before launch whenever such a policy file is present, and must name it.
  // Round 3 of #37 (q50): removing the macOS device plist or the Linux drop-in
  // directory from the candidate list passed every test above. Each source
  // Claude merges from outside the probe's roots is pinned on its own, so
  // deleting any single one fails (vendor utils/settings/managedPath.ts and
  // utils/settings/mdm/constants.ts).
  it.each([
    ['darwin', '/Library/Application Support/ClaudeCode/managed-settings.json'],
    ['darwin', '/Library/Application Support/ClaudeCode/managed-settings.d'],
    ['darwin', '/Library/Managed Preferences/dev/com.anthropic.claudecode.plist'],
    ['darwin', '/Library/Managed Preferences/com.anthropic.claudecode.plist'],
    ['linux', '/etc/claude-code/managed-settings.json'],
    ['linux', '/etc/claude-code/managed-settings.d'],
  ] as const)('refuses on %s when only %s exists', (platform, source) => {
    expect(managedPolicySources(platform, 'dev', path => path === source)).toEqual([source])
    expect(() => assertNoMachinePolicy(platform, 'dev', path => path === source)).toThrow(source)
  })

  it('the pre-launch gate refuses a machine policy that could run a statusLine command', () => {
    const policy = '/Library/Application Support/ClaudeCode/managed-settings.json'
    const policyContents: Record<string, string> = {
      [policy]: JSON.stringify({ statusLine: { type: 'command', command: '/usr/bin/touch /tmp/policy-canary' } }),
    }
    expect(() => assertNoMachinePolicy('darwin', 'dev', path => path in policyContents))
      .toThrow(/Refusing to run the Claude probe.*managed-settings\.json/)
    expect(() => assertNoMachinePolicy('darwin', 'dev', () => false)).not.toThrow()
  })

  it('launches in bare mode, where only --settings can supply an apiKeyHelper', () => {
    const args = claudeProbeArgs('00000000-0000-4000-8000-000000000215')
    expect(args).toContain('--bare')
    // Passing --settings would reopen the helper route bare mode closes.
    expect(args).not.toContain('--settings')
    expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2))
      .toEqual(['--resume', '00000000-0000-4000-8000-000000000215'])
  })
})

/** A PTY stand-in: the process is the true edge here, not the logic under test. */
function fakeTerminal(exitOn: ReadonlySet<string | undefined>) {
  const listeners: Array<() => void> = []
  const signals: Array<string | undefined> = []
  return {
    signals,
    exitNow: () => listeners.splice(0).forEach(listener => listener()),
    kill(signal?: string) {
      signals.push(signal)
      if (exitOn.has(signal)) setTimeout(() => listeners.splice(0).forEach(listener => listener()), 1)
    },
    onExit(listener: () => void) {
      listeners.push(listener)
    },
  }
}

describe('bounded probe exit', () => {
  it('returns exited when the CLI honours the first signal', async () => {
    const terminal = fakeTerminal(new Set([undefined]))
    expect(await watchExit(terminal).stop(50, 50)).toBe('exited')
    expect(terminal.signals).toEqual([undefined])
  })

  it('escalates to SIGKILL and reports killed', async () => {
    const terminal = fakeTerminal(new Set(['SIGKILL']))
    expect(await watchExit(terminal).stop(20, 50)).toBe('killed')
    expect(terminal.signals).toEqual([undefined, 'SIGKILL'])
  })

  it('gives up with stuck instead of hanging when no exit event ever arrives', async () => {
    const terminal = fakeTerminal(new Set())
    const started = Date.now()
    expect(await watchExit(terminal).stop(20, 20)).toBe('stuck')
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('sees an exit that happened before stop() was called', async () => {
    const terminal = fakeTerminal(new Set())
    const exit = watchExit(terminal)
    terminal.exitNow()
    expect(await exit.stop(20, 20)).toBe('exited')
    expect(terminal.signals).toEqual([])
  })
})

// Review of #37, b's verification pass: the env policy was pinned, but the live file's two launch
// call sites were not — dropping `{ env }` from the version spawn, or spreading process.env into it,
// handed the parent's credentials to the child with every test green. The launches now live in
// createClaudeProbe; these drive them with a REAL stand-in binary (a shell script that reports what
// it was given), so the process boundary itself is what is asserted.
describe.skipIf(process.platform === 'win32')('probe launches', () => {
  const hostile = {
    PATH: process.env.PATH,
    ANTHROPIC_API_KEY: 'sk-ant-synthetic',
    CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-oauth',
    CLAUDE_CONFIG_DIR: '/real/home/.claude',
  }

  async function standIn(): Promise<{ bin: string; roots: { configRoot: string; home: string; tmp: string }; cleanup(): Promise<void> }> {
    const root = await mkdtemp(join(tmpdir(), 'atp-probe-standin-'))
    const bin = join(root, 'claude')
    await writeFile(bin, '#!/bin/sh\nprintf "key=%s oauth=%s config=%s\\n" "${ANTHROPIC_API_KEY:-none}" "${CLAUDE_CODE_OAUTH_TOKEN:-none}" "${CLAUDE_CONFIG_DIR:-none}"\n')
    await chmod(bin, 0o755)
    const roots = { configRoot: join(root, 'config'), home: join(root, 'home'), tmp: join(root, 'tmp') }
    return { bin, roots, cleanup: () => rm(root, { recursive: true, force: true }) }
  }

  it('runs --version with the probe env, never the parent credentials', async () => {
    const { bin, roots, cleanup } = await standIn()
    try {
      const probe = createClaudeProbe(bin, hostile, roots, {
        spawnSync: (binary, args, options) => spawnSync(binary, args, options),
        spawnPty: () => { throw new Error('not used') },
      })
      const result = probe.version()
      expect(result.status).toBe(0)
      expect(result.stdout.trim()).toBe(`key=none oauth=none config=${roots.configRoot}`)
    } finally {
      await cleanup()
    }
  })

  it('spawns the terminal with the probe env and bare args, and waits for its exit before returning', async () => {
    const seen: Array<{ args: string[]; env: Record<string, string> }> = []
    const terminal = fakeTerminal(new Set())
    const probe = createClaudeProbe('claude', hostile, { configRoot: '/probe/config', home: '/probe/home', tmp: '/probe/tmp' }, {
      spawnSync: () => { throw new Error('not used') },
      spawnPty: (_binary, args, options) => {
        seen.push({ args, env: options.env })
        return terminal
      },
    })
    let settled = false
    const running = probe.withTerminal('00000000-0000-4000-8000-000000000215', '/probe/workspace', async () => 'rendered', { graceMs: 20, killMs: 20 })
      .then(run => { settled = true; return run })
    // The CLI has not exited yet: the run must not have returned, or cleanup would race its writes.
    await new Promise(resolveWait => setTimeout(resolveWait, 10))
    expect(settled).toBe(false)
    terminal.exitNow()
    await expect(running).resolves.toEqual({ result: 'rendered', stopped: 'exited' })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.args).toEqual(claudeProbeArgs('00000000-0000-4000-8000-000000000215'))
    expect(seen[0]!.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(seen[0]!.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(seen[0]!.env.CLAUDE_CONFIG_DIR).toBe('/probe/config')
  })

  it('still waits for the exit when the body throws, and hands the error back', async () => {
    const terminal = fakeTerminal(new Set([undefined]))
    const probe = createClaudeProbe('claude', hostile, { configRoot: '/c', home: '/h', tmp: '/t' }, {
      spawnSync: () => { throw new Error('not used') },
      spawnPty: () => terminal,
    })
    const run = await probe.withTerminal('00000000-0000-4000-8000-000000000215', '/w', async () => { throw new Error('history never rendered') }, { graceMs: 50, killMs: 50 })
    expect(run.stopped).toBe('exited')
    expect(String(run.error)).toMatch(/history never rendered/)
    expect(terminal.signals).toEqual([undefined])
  })
})


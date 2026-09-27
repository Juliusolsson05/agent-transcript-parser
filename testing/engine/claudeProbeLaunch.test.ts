import { describe, expect, it } from 'vitest'

import { PROBE_ENV_ALLOWLIST, claudeProbeArgs, claudeProbeEnv, watchExit } from './claudeProbeLaunch.js'

// WHY a deterministic test for a live probe's launch policy (agent-code#1295,
// steering q44): the live probe is opt-in and skipped everywhere else, so its
// "no real credential reaches the child" rule would otherwise be checked by
// nobody. These cases pin that rule and the bounded exit without Claude.

const roots = { configRoot: '/probe/config', home: '/probe/home' }

// Every credential route the review of agent-transcript-parser#37 traced to a
// Claude startup path, plus the ones the first version already stripped. The
// values are fixture-only; the names are what matter.
const HOSTILE_PARENT: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin',
  TERM: 'xterm-256color',
  LANG: 'en_US.UTF-8',
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
      CLAUDE_CONFIG_DIR: '/probe/config',
      CLAUDE_CODE_SIMPLE: '1',
      DISABLE_AUTOUPDATER: '1',
    })
    // No value from the hostile parent leaks under ANY key.
    const leaked = Object.values(env).filter(value => /fixture|real-developer|real-profile|proxy\.example/.test(value))
    expect(leaked).toEqual([])
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

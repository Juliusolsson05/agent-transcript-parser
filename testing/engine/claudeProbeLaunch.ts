// Launch policy for the opt-in Claude native-resume probe
// (nativeResume.claude.live.test.ts), split out so its safety rules are pinned
// by a deterministic test (claudeProbeLaunch.test.ts). The live test is skipped
// everywhere except a deliberate local run, so a rule that only lived inside it
// would be checked by nobody (agent-code#1295, steering q44).
//
// The probe only renders a resumed history: no login, no network, no prompt.
// Anything that lets the child reach a real credential is therefore pure risk.

/**
 * The ONLY parent variables the probe child inherits.
 *
 * WHY an allowlist and not a denylist: the first version stripped ANTHROPIC_*
 * and the OAuth token and still passed through CLAUDE_CODE_USE_BEDROCK,
 * AWS_BEARER_TOKEN_BEDROCK, AWS_PROFILE, CLAUDE_CODE_USE_VERTEX,
 * GOOGLE_APPLICATION_CREDENTIALS and CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR —
 * each a credential source Claude reads at startup (review of
 * agent-transcript-parser#37). Claude grows new provider selectors over time;
 * a denylist silently goes stale, an allowlist fails closed.
 *
 * What is here is what a PTY-rendered CLI needs to locate its binary and draw:
 * PATH (claude + node), terminal type, locale. Nothing names a user, a home, a
 * provider or a proxy.
 */
export const PROBE_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'TERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
]

export type ProbeRoots = {
  /** Throwaway TMPDIR, so Claude's own temp artifacts land inside the probe
   *  root that cleanup owns, not the developer's shared temp dir (review of #37). */
  tmp: string
  /** Throwaway CLAUDE_CONFIG_DIR (global config, projects, keychain service key). */
  configRoot: string
  /** Throwaway HOME, so home-based discovery (~/.aws, ~/.config/gcloud,
   *  a legacy ~/.claude.json) finds nothing real. */
  home: string
}

export function claudeProbeEnv(
  parent: NodeJS.ProcessEnv,
  roots: ProbeRoots,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of PROBE_ENV_ALLOWLIST) {
    const value = parent[key]
    if (value !== undefined) env[key] = value
  }
  env.TERM ??= 'xterm-256color'
  env.HOME = roots.home
  env.TMPDIR = roots.tmp
  env.CLAUDE_CONFIG_DIR = roots.configRoot
  // Belt and braces with --bare below: SIMPLE is what --bare sets internally
  // (vendor claude-code-src/full/main.tsx), so either alone keeps bare mode.
  env.CLAUDE_CODE_SIMPLE = '1'
  // A fresh config dir would otherwise let the probe start an auto-update of
  // the developer's real install.
  env.DISABLE_AUTOUPDATER = '1'
  return env
}

/**
 * Arguments for the probe's interactive resume.
 *
 * WHY --bare: machine policy (`/Library/Application Support/ClaudeCode` on
 * macOS, `/etc/claude-code` on Linux, MDM) lives OUTSIDE CLAUDE_CONFIG_DIR and
 * may set an `apiKeyHelper`, which normal startup executes with `shell: true`
 * before any prompt (vendor utils/auth.ts prefetchApiKeyFromApiKeyHelperIfSafe,
 * called from setup.ts). In bare mode `getConfiguredApiKeyHelper()` reads ONLY
 * `--settings` flag settings (utils/auth.ts:355-358), keychain reads are
 * skipped, and startDeferredPrefetches (Bedrock/Vertex credential prefetch,
 * user context) returns early (main.tsx). We pass no --settings, so no helper
 * can run. Bare mode keeps the interactive REPL and --resume, which is all the
 * probe exercises.
 */
export function claudeProbeArgs(sessionId: string): string[] {
  return [
    '--bare',
    '--resume',
    sessionId,
    '--safe-mode',
    '--permission-mode',
    'dontAsk',
  ]
}

/**
 * Machine-policy sources that Claude reads from OUTSIDE CLAUDE_CONFIG_DIR, and that exist here.
 *
 * WHY the probe refuses to run when any exists (steering q44, round 2 of #37): policy settings
 * are merged even in bare mode, and more than one policy key runs a shell command at startup
 * without a bare guard. `statusLine` executes when the prompt footer mounts
 * (vendor components/StatusLine.tsx -> utils/hooks.ts executeStatusLineCommand, spawned with
 * `shell: true`), `otelHeadersHelper` when telemetry is enabled, and policy `env` is applied at
 * startup. Blocking each key one by one would go stale the next time Claude adds one. So the
 * boundary is: no machine policy, or no probe. An explicit opt-in run fails loudly rather than
 * silently skipping, because a skipped run would claim coverage it did not provide.
 *
 * Paths come from vendor utils/settings/managedPath.ts (file + managed-settings.d drop-ins) and
 * utils/settings/mdm/constants.ts (per-user and device plists). Windows keeps policy in the
 * registry (HKLM/HKCU\\SOFTWARE\\Policies\\ClaudeCode), which this probe does not read, so
 * Windows fails closed as "unknown". The remote managed-settings cache lives in
 * CLAUDE_CONFIG_DIR, which is throwaway, so it needs no check.
 */
export function managedPolicySources(
  platform: NodeJS.Platform,
  username: string,
  exists: (path: string) => boolean,
): string[] {
  if (platform === 'win32') return ['Windows registry policy (HKLM/HKCU\\SOFTWARE\\Policies\\ClaudeCode): cannot be ruled out']
  const candidates = platform === 'darwin'
    ? [
        '/Library/Application Support/ClaudeCode/managed-settings.json',
        '/Library/Application Support/ClaudeCode/managed-settings.d',
        `/Library/Managed Preferences/${username}/com.anthropic.claudecode.plist`,
        '/Library/Managed Preferences/com.anthropic.claudecode.plist',
      ]
    : ['/etc/claude-code/managed-settings.json', '/etc/claude-code/managed-settings.d']
  return candidates.filter(path => exists(path))
}

/**
 * The probe's pre-launch gate: throws, naming the sources, when any machine policy exists.
 * Called before the probe creates anything, so a refusal leaves nothing behind.
 */
export function assertNoMachinePolicy(
  platform: NodeJS.Platform,
  username: string,
  exists: (path: string) => boolean,
): void {
  const sources = managedPolicySources(platform, username, exists)
  if (sources.length > 0) {
    throw new Error(
      `Refusing to run the Claude probe: machine policy can execute commands outside its sandbox (${sources.join(', ')})`,
    )
  }
}

type Killable = {
  kill(signal?: string): void
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown
}

/**
 * Stop the probe and wait for it to exit, with a hard deadline.
 *
 * WHY wait at all: Claude saves its global config (plus a backups/ copy) from
 * its shutdown handler AFTER the kill signal; removing the config dir right
 * after kill() raced that save and left a recreated dir behind.
 *
 * WHY bounded: node-pty's onExit is an event with no replay, and a stalled PTY
 * may never deliver it. An unbounded await would hang cleanup and leave both
 * temp roots on disk (review of #37). The caller removes the roots whatever
 * this returns, and fails the test on 'stuck' so the leak is visible.
 *
 * Subscribe with `watchExit` right after spawn, before anything can throw, so a
 * fast exit is never missed.
 */
export function watchExit(terminal: Killable): { stop(graceMs?: number, killMs?: number): Promise<'exited' | 'killed' | 'stuck'> } {
  let exited = false
  let onExited: (() => void) | undefined
  terminal.onExit(() => {
    exited = true
    onExited?.()
  })
  const exitWithin = (ms: number) => new Promise<boolean>(resolveWait => {
    if (exited) return resolveWait(true)
    const timer = setTimeout(() => resolveWait(exited), ms)
    onExited = () => {
      clearTimeout(timer)
      resolveWait(true)
    }
  })
  return {
    async stop(graceMs = 5_000, killMs = 2_000) {
      if (exited) return 'exited'
      terminal.kill()
      if (await exitWithin(graceMs)) return 'exited'
      terminal.kill('SIGKILL')
      if (await exitWithin(killMs)) return 'killed'
      return 'stuck'
    },
  }
}

/** The two process launches the probe makes; injected so the core tests can observe them. */
export type ProbeSpawners<Terminal extends Killable> = {
  spawnSync(
    binary: string,
    args: string[],
    options: { encoding: 'utf8'; env: Record<string, string> },
  ): { status: number | null; stdout: string; stderr: string }
  spawnPty(
    binary: string,
    args: string[],
    options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
  ): Terminal
}

/**
 * Every process the probe starts, with the probe env built HERE and nowhere else.
 *
 * WHY the launches live in this module (review of #37, b's verification pass): the env policy was
 * tested, but the live file's two call sites were not. Dropping `{ env }` from the `--version`
 * spawn, or spreading `process.env` into it, gave the child the parent's API key and OAuth token
 * while every core test and the live history check stayed green. Here the caller never holds the
 * env at all, so there is nothing to drop or widen at a call site, and the core tests drive both
 * launches with a stand-in binary.
 *
 * WHY `withTerminal` owns the exit wait: the live test's `stopped = await exit.stop()` could be
 * reduced to a fire-and-forget stop, and the probe root was removed while the CLI was still
 * shutting down, which recreated it afterwards. The helper resolves only after the stop settles.
 */
export function createClaudeProbe<Terminal extends Killable>(
  binary: string,
  parent: NodeJS.ProcessEnv,
  roots: ProbeRoots,
  spawners: ProbeSpawners<Terminal>,
) {
  const env = claudeProbeEnv(parent, roots)
  return {
    version(): { status: number | null; stdout: string; stderr: string } {
      return spawners.spawnSync(binary, ['--version'], { encoding: 'utf8', env })
    },
    async withTerminal<T>(
      sessionId: string,
      cwd: string,
      body: (terminal: Terminal) => Promise<T>,
      stopTimings?: { graceMs?: number; killMs?: number },
    ): Promise<{ result?: T; error?: unknown; stopped: 'exited' | 'killed' | 'stuck' }> {
      const terminal = spawners.spawnPty(binary, claudeProbeArgs(sessionId), {
        name: 'xterm-256color', cols: 160, rows: 50, cwd, env,
      })
      // Subscribed before anything else can throw, so a fast exit is never missed.
      const exit = watchExit(terminal)
      let result: T | undefined
      let error: unknown
      try {
        result = await body(terminal)
      } catch (cause) {
        error = cause
      }
      const stopped = await exit.stop(stopTimings?.graceMs, stopTimings?.killMs)
      return error === undefined ? { result, stopped } : { error, stopped }
    },
  }
}

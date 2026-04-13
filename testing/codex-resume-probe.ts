// Launch `codex resume <session-id>` in a PTY, capture the rendered
// TUI buffer for a few seconds, then kill the process and return the
// captured bytes. Lets us programmatically check whether a
// translator-produced rollout file renders correctly in Codex.
//
// Usage:
//   npx tsx testing/codex-resume-probe.ts <session-id> [--needle "text"]
//
// Exits 0 if the optional --needle string appears in captured output,
// 1 otherwise. Without --needle, just prints the capture.

import { spawn as ptySpawn } from 'node-pty'

const args = process.argv.slice(2)
const sessionId = args[0]
if (!sessionId) {
  console.error('usage: tsx codex-resume-probe.ts <session-id> [--needle "text"]')
  process.exit(2)
}
const needleIdx = args.indexOf('--needle')
const needle = needleIdx >= 0 ? args[needleIdx + 1] : null

const CAPTURE_MS = Number(process.env.ATP_CAPTURE_MS ?? 5000)
// CWD matters: `codex resume` filters the picker to sessions recorded
// from the current working directory. Set ATP_PROBE_CWD to the cwd the
// target session was recorded from, or this script will find nothing.
const CWD = process.env.ATP_PROBE_CWD ?? process.cwd()

// Codex binary. Defaults to whatever `codex` resolves to on PATH.
// Override with ATP_CODEX_BIN for a specific install.
const CODEX_BIN = process.env.ATP_CODEX_BIN ?? 'codex'
const pty = ptySpawn(CODEX_BIN, ['resume', sessionId], {
  name: 'xterm-256color',
  cols: 200,
  rows: 60,
  cwd: CWD,
  env: {
    ...(process.env as Record<string, string>),
    TERM: 'xterm-256color',
    CI: '1',
  },
})

let buffer = ''
pty.onData(d => { buffer += d })

const deadline = Date.now() + CAPTURE_MS
await new Promise<void>(resolve => {
  const tick = () => {
    if (Date.now() >= deadline) return resolve()
    setTimeout(tick, 100)
  }
  tick()
})

try { pty.kill() } catch { /* already gone */ }

// Strip ANSI escapes so grep works on the plain text.
const plain = buffer.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1B\]\S*?\x07/g, '')

if (needle) {
  const found = plain.includes(needle)
  console.log(found ? `✓ FOUND "${needle}"` : `✗ MISSING "${needle}"`)
  if (!found) {
    console.log('--- last 2000 chars of capture ---')
    console.log(plain.slice(-2000))
  }
  process.exit(found ? 0 : 1)
} else {
  console.log(plain)
}

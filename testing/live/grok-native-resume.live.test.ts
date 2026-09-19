import { createServer } from 'node:http'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { expect, it } from 'vitest'
import { decodeGrokConversation } from '../../src/grok/conversation/decode.js'
import { projectGrokNativeResume } from '../../src/grok/project/project.js'

// Native-load evidence, not paid-model correctness: the installed CLI must
// reconstruct the projected history into its actual inference request before
// the local backend will answer. No real auth/config is copied or modified.
it('loads the projected file set, installs native instructions and sends the imported tool cycle', async context => {
  if (process.env.GROK_PARSER_LIVE !== '1') context.skip('Set GROK_PARSER_LIVE=1 for the installed-CLI resume gate')
  const binary = process.env.GROK_BINARY ?? join(homedir(), '.local', 'bin', 'grok')
  if (!existsSync(binary)) context.skip('Grok CLI unavailable')
  const wirePath = process.env.GROK_NATIVE_RESPONSE_FIXTURE
  if (!wirePath) context.skip('Provide the native-valid minimized response fixture through GROK_NATIVE_RESPONSE_FIXTURE')
  const pty = createRequire(import.meta.url)('node-pty') as typeof import('node-pty')
  const root = mkdtempSync(join(tmpdir(), 'grok-projection-'))
  const home = join(root, '.grok')
  const sessionId = randomUUID()
  const records = readFileSync(new URL('../../fixtures/evidence/grok/command.jsonl', import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const projected = projectGrokNativeResume(decodeGrokConversation(records), { targetSessionId: sessionId, cwd: root, model: 'grok-4.6', now: new Date().toISOString() })
  const encoded = encodeURIComponent(realpathSync(root)).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  const directory = join(home, 'sessions', encoded, sessionId)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'summary.json'), JSON.stringify(projected.summary))
  writeFileSync(join(directory, 'chat_history.jsonl'), projected.values.map(value => JSON.stringify(value)).join('\n') + '\n')
  writeFileSync(join(directory, 'updates.jsonl'), '')
  writeFileSync(join(home, 'config.toml'), '[cli]\nauto_update = false\n')
  const wire = readFileSync(wirePath!)
  let importedContext = false
  let nativeSystem = false
  const server = createServer(async (req, res) => {
    if (req.url?.startsWith('/v1/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'grok-4.6', model: 'grok-4.6', api_backend: 'responses', context_window: 500000 }] }))
      return
    }
    if (req.url === '/v1/responses') {
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) { res.writeHead(413); res.end(); return }; chunks.push(chunk) }
      const body = JSON.parse(Buffer.concat(chunks).toString())
      const text = JSON.stringify(body.input)
      if (text.includes('PERMISSION_PROBE.txt') && text.includes('call_fixture') && text.includes('exit: 0')) importedContext = true
      if (Array.isArray(body.input) && body.input[0]?.role === 'system' && !text.includes('[Native system instructions omitted]')) nativeSystem = true
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(wire)
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}')
  })
  let term: import('node-pty').IPty | undefined
  let exited = false
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing local server address')
    const base = `http://127.0.0.1:${address.port}/v1`
    term = pty.spawn(binary, ['--no-auto-update', '--resume', sessionId], {
      name: 'xterm-256color', cols: 120, rows: 40, cwd: root,
      env: { PATH: process.env.PATH, HOME: root, GROK_HOME: home, XDG_CONFIG_HOME: join(root, '.config'), TERM: 'xterm-256color', XAI_API_KEY: 'fixture-only-not-a-real-key', GROK_MODELS_BASE_URL: base, GROK_XAI_API_BASE_URL: base, GROK_CLI_CHAT_PROXY_BASE_URL: base, OTEL_TRACES_EXPORTER: 'none' },
    })
    let painted = false
    term.onData(() => { painted = true })
    term.onExit(() => { exited = true })
    const ready = performance.now() + 15000
    while (!painted && !exited && performance.now() < ready) await new Promise(resolve => setTimeout(resolve, 50))
    expect(painted && !exited).toBe(true)
    term.write('\x1b[200~What command did we previously run? Reply PAPAYA without using tools.\x1b[201~\r')
    const deadline = performance.now() + 45000
    let appended = false
    while (!appended && !exited && performance.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100))
      appended = readFileSync(join(directory, 'chat_history.jsonl'), 'utf8').split('\n').some(line => {
        try { const value = JSON.parse(line); return value.type === 'assistant' && value.content === 'PAPAYA' } catch { return false }
      })
    }
    expect(importedContext, 'projected user/tool/result history reached native inference').toBe(true)
    expect(nativeSystem, 'target created its own native system prompt').toBe(true)
    expect(appended, 'native resumed session appended a completed assistant record').toBe(true)
  } finally {
    try {
      if (term && !exited) {
        term.kill()
        const limit = performance.now() + 3000
        while (!exited && performance.now() < limit) await new Promise(resolve => setTimeout(resolve, 50))
        if (!exited) { term.kill('SIGKILL'); await new Promise(resolve => setTimeout(resolve, 250)) }
      }
    } finally {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
      if (!term || exited) rmSync(root, { recursive: true, force: true })
    }
  }
}, 75000)

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

import { describe, expect, it } from 'vitest'

import { projectCodexNativeResume } from '../../src/v2/codex/project/nativeResume.js'
import type { ConversationDocument } from '../../src/v2/conversation/types.js'

const enabled = process.env.ATP_RUN_NATIVE_CODEX === '1'
const codexBinary = process.env.ATP_CODEX_BIN ?? 'codex'

describe.skipIf(!enabled)('controlled Codex native-resume compatibility', () => {
  it('is discovered, reconstructed, and appendable by the installed app-server', async () => {
    const versionResult = spawnSync(codexBinary, ['--version'], { encoding: 'utf8' })
    expect(versionResult.status, versionResult.stderr).toBe(0)
    const cliVersion = versionResult.stdout.trim().replace(/^codex-cli\s+/, '')
    const probeRoot = await mkdtemp(join(tmpdir(), 'atp-codex-resume-'))
    const codexHome = join(probeRoot, 'codex-home')
    const cwd = join(probeRoot, 'workspace')
    const sessionId = '00000000-0000-4000-8000-000000000144'
    const now = '2026-07-20T12:00:00.000Z'
    const projection = projectCodexNativeResume(conversation(now), {
      targetSessionId: sessionId,
      now,
      cwd,
      cliVersion,
      modelProvider: 'openai',
      model: 'gpt-5',
    })
    const rolloutPath = join(
      codexHome,
      'sessions',
      '2026',
      '07',
      '20',
      `rollout-2026-07-20T12-00-00-${sessionId}.jsonl`,
    )
    await mkdir(dirname(rolloutPath), { recursive: true })
    await mkdir(cwd, { recursive: true })
    await writeFile(
      rolloutPath,
      `${projection.values.map(value => JSON.stringify(value)).join('\n')}\n`,
      'utf8',
    )

    const server = spawn(codexBinary, ['app-server', '--listen', 'stdio://'], {
      cwd,
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const rpc = jsonRpc(server)
    try {
      await rpc.request('initialize', {
        clientInfo: { name: 'atp-native-probe', title: null, version: '1' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      })
      rpc.notify('initialized')

      const listed = await rpc.request('thread/list', {
        limit: 20,
        sourceKinds: [],
      }) as { data?: Array<{ id?: string }> }
      expect(listed.data?.some(thread => thread.id === sessionId)).toBe(true)

      const resumed = await rpc.request('thread/resume', {
        threadId: sessionId,
      }) as {
        thread?: { id?: string; turns?: unknown[] }
        modelProvider?: string
      }
      expect(resumed.thread?.id).toBe(sessionId)
      expect(resumed.thread?.turns?.length).toBeGreaterThan(0)
      expect(resumed.modelProvider).toBe('openai')

      await rpc.request('thread/inject_items', {
        threadId: sessionId,
        items: [{
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'controlled append probe' }],
        }],
      })
      await waitForText(rolloutPath, 'controlled append probe')
      expect(await readFile(rolloutPath, 'utf8')).toContain('controlled append probe')
    } finally {
      rpc.close()
      await rm(probeRoot, { recursive: true, force: true })
    }
  }, 30_000)
})

function conversation(now: string): ConversationDocument {
  return {
    schemaVersion: 1,
    sourceProvider: 'claude',
    sourceSessionIds: ['fixture-source'],
    entries: [
      message('user', 'controlled resume prompt', 0, now),
      message('assistant', 'controlled resume answer', 1, now),
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
    source: { provider: 'claude', line, raw: {}, evidence: [] },
  }
}

function jsonRpc(process: ChildProcessWithoutNullStreams) {
  let nextId = 1
  const pending = new Map<number, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
  }>()
  let stderr = ''
  process.stderr.on('data', chunk => {
    stderr += String(chunk)
  })
  createInterface({ input: process.stdout }).on('line', line => {
    let message: { id?: number; result?: unknown; error?: unknown }
    try {
      message = JSON.parse(line) as typeof message
    } catch {
      return
    }
    if (typeof message.id !== 'number') return
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.error !== undefined) {
      waiter.reject(new Error(`Codex app-server RPC failed: ${JSON.stringify(message.error)}`))
    } else {
      waiter.resolve(message.result)
    }
  })

  return {
    request(method: string, params: unknown): Promise<unknown> {
      const id = nextId
      nextId += 1
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`Timed out waiting for ${method}. stderr: ${stderr}`))
        }, 10_000)
        pending.set(id, {
          resolve(value) {
            clearTimeout(timeout)
            resolve(value)
          },
          reject(error) {
            clearTimeout(timeout)
            reject(error)
          },
        })
        process.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
      })
    },
    notify(method: string): void {
      process.stdin.write(`${JSON.stringify({ method })}\n`)
    },
    close(): void {
      process.kill('SIGTERM')
    },
  }
}

async function waitForText(path: string, needle: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if ((await readFile(path, 'utf8')).includes(needle)) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Codex did not append ${JSON.stringify(needle)} to the resumed rollout.`)
}

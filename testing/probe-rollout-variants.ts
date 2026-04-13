// Build and probe reduced variants of a Codex rollout file.
//
// This exists for the Claude -> Codex rendering investigation:
// some translated sessions load and show user messages, but assistant
// messages disappear. We already know:
//   - removing atp_passthrough is NOT enough
//   - keeping only session_meta + turn wrappers + user/agent events
//     DOES render assistant messages
//
// So the next useful move is to add rollout item classes back in
// controlled buckets and probe each variant.
//
// Usage:
//   npx tsx testing/probe-rollout-variants.ts <rollout.jsonl> <cwd>
//
// The script writes each variant to ~/.codex/sessions/YYYY/MM/DD/,
// probes `codex resume <session-id>`, strips ANSI, then prints counts
// of rendered user (`›`) and assistant (`•`) markers.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { spawn as ptySpawn } from 'node-pty'

type RolloutLine = {
  timestamp: string
  type: string
  payload?: Record<string, unknown>
  _atp?: unknown
}

const SRC = process.argv[2]
const CWD = process.argv[3]
if (!SRC || !CWD) {
  console.error(
    'usage: tsx testing/probe-rollout-variants.ts <rollout.jsonl> <cwd>',
  )
  process.exit(2)
}

const CODEX_BIN = process.env.ATP_CODEX_BIN ?? 'codex'
const CAPTURE_MS = Number(process.env.ATP_CAPTURE_MS ?? 12000)

const allLines: RolloutLine[] = readFileSync(SRC, 'utf8')
  .trim()
  .split('\n')
  .map(line => JSON.parse(line) as RolloutLine)

function parseType(line: RolloutLine): string {
  const payloadType = line.payload?.type
  return typeof payloadType === 'string'
    ? `${line.type}:${payloadType}`
    : line.type
}

function keepEventsOnly(line: RolloutLine): boolean {
  const kind = parseType(line)
  return (
    kind === 'session_meta' ||
    kind === 'turn_context' ||
    kind === 'event_msg:task_started' ||
    kind === 'event_msg:task_complete' ||
    kind === 'event_msg:user_message' ||
    kind === 'event_msg:agent_message'
  )
}

function keepMessageResponseItems(line: RolloutLine): boolean {
  return keepEventsOnly(line) || parseType(line) === 'response_item:message'
}

function keepReasoning(line: RolloutLine): boolean {
  return keepMessageResponseItems(line) || parseType(line) === 'response_item:reasoning'
}

function keepToolCalls(line: RolloutLine): boolean {
  const kind = parseType(line)
  return (
    keepMessageResponseItems(line) ||
    kind === 'response_item:function_call' ||
    kind === 'response_item:function_call_output' ||
    kind === 'response_item:custom_tool_call' ||
    kind === 'response_item:custom_tool_call_output' ||
    kind === 'response_item:local_shell_call' ||
    kind === 'response_item:web_search_call'
  )
}

function keepAllNoPassthrough(line: RolloutLine): boolean {
  return line.type !== 'atp_passthrough'
}

const variants: Array<{ name: string; keep: (line: RolloutLine) => boolean }> = [
  { name: 'full-exact', keep: () => true },
  { name: 'events-only', keep: keepEventsOnly },
  { name: 'events-plus-message-response-items', keep: keepMessageResponseItems },
  { name: 'events-plus-reasoning', keep: keepReasoning },
  { name: 'events-plus-tools', keep: keepToolCalls },
  { name: 'full-minus-passthrough', keep: keepAllNoPassthrough },
]

function stripAnsi(text: string): string {
  return text
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1B\].*?\x07/g, '')
}

function countMarkers(text: string, marker: string): number {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(`^(?:  )?${escaped}`, 'gm')
  return [...text.matchAll(regex)].length
}

function writeVariant(name: string, lines: RolloutLine[]): { sessionId: string; path: string } {
  const sessionId = randomUUID()
  const dir = join(homedir(), '.codex', 'sessions', '2026', '04', '13')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `rollout-2026-04-13T19-20-00-${sessionId}.jsonl`)

  const rewritten = lines.map((line, index) => {
    if (index === 0 && line.type === 'session_meta' && line.payload) {
      return {
        ...line,
        payload: {
          ...line.payload,
          id: sessionId,
          cwd: CWD,
        },
      }
    }
    return line
  })

  writeFileSync(path, rewritten.map(line => JSON.stringify(line)).join('\n') + '\n')
  return { sessionId, path }
}

function probe(sessionId: string): Promise<string> {
  return new Promise(resolve => {
    const pty = ptySpawn(CODEX_BIN, ['resume', sessionId], {
      name: 'xterm-256color',
      cols: 220,
      rows: 70,
      cwd: CWD,
      env: {
        ...(process.env as Record<string, string>),
        TERM: 'xterm-256color',
        CI: '1',
      },
    })

    let buffer = ''
    pty.onData(d => {
      buffer += d
    })

    setTimeout(() => {
      try {
        pty.kill()
      } catch {
        // already exited
      }
      resolve(stripAnsi(buffer))
    }, CAPTURE_MS)
  })
}

for (const variant of variants) {
  const picked = allLines.filter(variant.keep)
  const { sessionId, path } = writeVariant(variant.name, picked)
  const plain = await probe(sessionId)
  const userMarkers = countMarkers(plain, '›')
  const agentMarkers = countMarkers(plain, '•')

  console.log(
    JSON.stringify(
      {
        variant: variant.name,
        sessionId,
        path,
        lines: picked.length,
        userMarkers,
        agentMarkers,
      },
      null,
      2,
    ),
  )
}

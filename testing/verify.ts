// Standalone round-trip runner (tsx). Loads every fixture, converts
// both directions, asserts deepEqual. Mirrors the verify.ts pattern
// from claude-code-headless / codex-headless — no jest dependency.

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { toClaude } from '../src/toClaude.js'
import { toCodex } from '../src/toCodex.js'
import type { ClaudeEntry, CodexRolloutLine } from '../src/types.js'

const here = dirname(fileURLToPath(import.meta.url))
const CODEX_DIR = join(here, '..', 'fixtures', 'codex')
const CLAUDE_DIR = join(here, '..', 'fixtures', 'claude')

let failed = 0

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`✓ ${label}`)
  else {
    console.error(`✗ ${label}${detail ? ` — ${detail}` : ''}`)
    failed++
  }
}

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as T)
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value)
}

// ---------------------------------------------------------------------------
// Codex → Claude smoke checks
// ---------------------------------------------------------------------------

for (const name of readdirSync(CODEX_DIR).filter(f => f.endsWith('.jsonl'))) {
  const codex = readJsonl<CodexRolloutLine>(join(CODEX_DIR, name))
  let claude: ClaudeEntry[] = []
  let threw: unknown = null
  try {
    claude = toClaude(codex)
  } catch (err) {
    threw = err
  }
  check(`codex/${name} converts without throwing`, threw === null, String(threw))
  check(`codex/${name} emits at least one entry`, claude.length > 0)
  check(
    `codex/${name} every entry has uuid + sessionId`,
    claude.every(e => typeof e.uuid === 'string' && typeof e.sessionId === 'string'),
  )
}

// ---------------------------------------------------------------------------
// Claude → Codex smoke checks
// ---------------------------------------------------------------------------

for (const name of readdirSync(CLAUDE_DIR).filter(f => f.endsWith('.jsonl'))) {
  const claude = readJsonl<ClaudeEntry>(join(CLAUDE_DIR, name))
  let codex: CodexRolloutLine[] = []
  let threw: unknown = null
  try {
    codex = toCodex(claude)
  } catch (err) {
    threw = err
  }
  check(`claude/${name} converts without throwing`, threw === null, String(threw))
  check(`claude/${name} emits at least one line`, codex.length > 0)
  check(
    `claude/${name} first line is session_meta`,
    codex[0]?.type === 'session_meta',
  )
}

// ---------------------------------------------------------------------------
// Round-trip: Codex → Claude → Codex === Codex
// ---------------------------------------------------------------------------

for (const name of readdirSync(CODEX_DIR).filter(f => f.endsWith('.jsonl'))) {
  const original = readJsonl<CodexRolloutLine>(join(CODEX_DIR, name))
  const claude = toClaude(original)
  const roundTrip = toCodex(claude)
  const ok = stableStringify(roundTrip) === stableStringify(original)
  check(
    `codex/${name} round-trip (Codex→Claude→Codex) bytes match`,
    ok,
    ok ? undefined : `lengths: ${original.length} → ${claude.length} → ${roundTrip.length}`,
  )
}

// ---------------------------------------------------------------------------
// Round-trip: Claude → Codex → Claude === Claude
// ---------------------------------------------------------------------------

for (const name of readdirSync(CLAUDE_DIR).filter(f => f.endsWith('.jsonl'))) {
  const original = readJsonl<ClaudeEntry>(join(CLAUDE_DIR, name))
  const codex = toCodex(original)
  const roundTrip = toClaude(codex)
  const ok = stableStringify(roundTrip) === stableStringify(original)
  check(
    `claude/${name} round-trip (Claude→Codex→Claude) bytes match`,
    ok,
    ok ? undefined : `lengths: ${original.length} → ${codex.length} → ${roundTrip.length}`,
  )
}

// ---------------------------------------------------------------------------
// Lossy mode: no _atp in output
// ---------------------------------------------------------------------------

for (const name of readdirSync(CODEX_DIR).filter(f => f.endsWith('.jsonl'))) {
  const codex = readJsonl<CodexRolloutLine>(join(CODEX_DIR, name))
  const claudeLossy = toClaude(codex, { lossy: true })
  const hasAtp = JSON.stringify(claudeLossy).includes('"_atp"')
  check(`codex/${name} lossy mode strips _atp`, !hasAtp)
}

for (const name of readdirSync(CLAUDE_DIR).filter(f => f.endsWith('.jsonl'))) {
  const claude = readJsonl<ClaudeEntry>(join(CLAUDE_DIR, name))
  const codexLossy = toCodex(claude, { lossy: true })
  const hasAtp = JSON.stringify(codexLossy).includes('"_atp"')
  check(`claude/${name} lossy mode strips _atp`, !hasAtp)
}

// ---------------------------------------------------------------------------
// Native mapping assertions for high-value custom cases
// ---------------------------------------------------------------------------

{
  const queuedAttachment: ClaudeEntry = {
    type: 'attachment',
    uuid: 'att-1',
    parentUuid: null,
    sessionId: 'sess-1',
    timestamp: '2026-04-13T12:00:00.000Z',
    attachment: {
      type: 'queued_command',
      prompt: 'Run the verification script',
      isMeta: true,
    },
  }

  const codex = toCodex([queuedAttachment], { lossy: true })
  check(
    'queued_command attachment emits a native Codex user_message event',
    codex.some(
      line =>
        line.type === 'event_msg' &&
        (line.payload as { type?: string }).type === 'user_message' &&
        (line.payload as { message?: string }).message === 'Run the verification script',
    ),
  )
  check(
    'queued_command attachment emits a native Codex user response_item',
    codex.some(
      line =>
        line.type === 'response_item' &&
        (line.payload as { type?: string; role?: string }).type === 'message' &&
        (line.payload as { role?: string }).role === 'user',
    ),
  )
}

{
  const bashAssistant: ClaudeEntry = {
    type: 'assistant',
    uuid: 'asst-1',
    parentUuid: null,
    sessionId: 'sess-2',
    timestamp: '2026-04-13T12:01:00.000Z',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'shell-1',
          name: 'Bash',
          input: {
            command: 'rg "toolUseResult" src',
            workdir: '/tmp/project',
          },
        },
      ],
    },
  }

  const codex = toCodex([bashAssistant], { lossy: true })
  check(
    'Bash tool use emits local_shell_call',
    codex.some(
      line =>
        line.type === 'response_item' &&
        (line.payload as { type?: string }).type === 'local_shell_call',
    ),
  )

  const back = toClaude(codex, { lossy: true })
  const bashBack = back.find(entry => entry.type === 'assistant')
  const bashBlock = Array.isArray(bashBack?.message?.content)
    ? bashBack?.message?.content[0]
    : undefined

  check(
    'local_shell_call round-trips back to Claude Bash tool use',
    Boolean(
      bashBlock &&
        bashBlock.type === 'tool_use' &&
        (bashBlock as { name?: string }).name === 'Bash',
    ),
  )
}

{
  const editedAttachment: ClaudeEntry = {
    type: 'attachment',
    uuid: 'att-2',
    parentUuid: null,
    sessionId: 'sess-3',
    timestamp: '2026-04-13T12:02:00.000Z',
    attachment: {
      type: 'edited_text_file',
      filename: 'src/toCodex.ts',
      snippet: 'Updated mapping logic.',
    },
  }

  const codex = toCodex([editedAttachment], { lossy: true })
  check(
    'edited_text_file attachment emits visible Codex assistant commentary',
    codex.some(
      line =>
        line.type === 'event_msg' &&
        (line.payload as { type?: string }).type === 'agent_message' &&
        (line.payload as { message?: string }).message === 'Edited file: src/toCodex.ts',
    ),
  )
  check(
    'edited_text_file attachment emits paired assistant response_item',
    codex.some(
      line =>
        line.type === 'response_item' &&
        (line.payload as { type?: string; role?: string; phase?: string }).type === 'message' &&
        (line.payload as { role?: string }).role === 'assistant' &&
        (line.payload as { phase?: string }).phase === 'commentary',
    ),
  )
}

{
  const diagnosticsAttachment: ClaudeEntry = {
    type: 'attachment',
    uuid: 'att-3',
    parentUuid: null,
    sessionId: 'sess-4',
    timestamp: '2026-04-13T12:03:00.000Z',
    attachment: {
      type: 'diagnostics',
      isNew: true,
      files: [
        {
          uri: 'file:///tmp/project/src/index.ts',
          diagnostics: [
            {
              message: 'Unused variable',
              severity: 'Warning',
            },
            {
              message: 'Type mismatch',
              severity: 'Error',
            },
          ],
        },
      ],
    },
  }

  const codex = toCodex([diagnosticsAttachment], { lossy: true })
  check(
    'diagnostics attachment emits visible Codex assistant commentary',
    codex.some(
      line =>
        line.type === 'event_msg' &&
        (line.payload as { type?: string }).type === 'agent_message' &&
        typeof (line.payload as { message?: string }).message === 'string' &&
        (line.payload as { message: string }).message.includes('Received 2 diagnostics'),
    ),
  )
  check(
    'diagnostics attachment emits paired assistant response_item',
    codex.some(
      line =>
        line.type === 'response_item' &&
        (line.payload as { type?: string; role?: string; phase?: string }).type === 'message' &&
        (line.payload as { role?: string }).role === 'assistant' &&
        (line.payload as { phase?: string }).phase === 'commentary',
    ),
  )
}

{
  const planAttachment: ClaudeEntry = {
    type: 'attachment',
    uuid: 'att-4',
    parentUuid: null,
    sessionId: 'sess-5',
    timestamp: '2026-04-13T12:04:00.000Z',
    attachment: {
      type: 'plan_mode',
      reminderType: 'full',
      planFilePath: '/tmp/project/plan.md',
      planExists: true,
    },
  }

  const autoExitAttachment: ClaudeEntry = {
    type: 'attachment',
    uuid: 'att-5',
    parentUuid: null,
    sessionId: 'sess-6',
    timestamp: '2026-04-13T12:05:00.000Z',
    attachment: {
      type: 'auto_mode_exit',
    },
  }

  const planCodex = toCodex([planAttachment], { lossy: true })
  const autoCodex = toCodex([autoExitAttachment], { lossy: true })

  check(
    'plan_mode attachment emits assistant commentary',
    planCodex.some(
      line =>
        line.type === 'event_msg' &&
        (line.payload as { type?: string }).type === 'agent_message' &&
        (line.payload as { message?: string }).message === 'Plan mode reminder (full).',
    ),
  )
  check(
    'auto_mode_exit attachment emits assistant commentary',
    autoCodex.some(
      line =>
        line.type === 'event_msg' &&
        (line.payload as { type?: string }).type === 'agent_message' &&
        (line.payload as { message?: string }).message === 'Exited auto mode.',
    ),
  )
}

// ---------------------------------------------------------------------------
// Exit
// ---------------------------------------------------------------------------

if (failed > 0) {
  console.error(`\n${failed} check${failed === 1 ? '' : 's'} failed`)
  process.exit(1)
}
console.log('\nAll checks passed')

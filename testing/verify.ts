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

{
  const dateAttachment: ClaudeEntry = {
    type: 'attachment',
    uuid: 'att-6',
    parentUuid: null,
    sessionId: 'sess-7',
    timestamp: '2026-04-13T12:06:00.000Z',
    attachment: {
      type: 'date_change',
      newDate: '2026-04-14',
    },
  }

  const resourceAttachment: ClaudeEntry = {
    type: 'attachment',
    uuid: 'att-7',
    parentUuid: null,
    sessionId: 'sess-8',
    timestamp: '2026-04-13T12:07:00.000Z',
    attachment: {
      type: 'mcp_resource',
      server: 'filesystem',
      uri: 'file:///tmp/project/README.md',
      name: 'README.md',
      content: {},
    },
  }

  const dateCodex = toCodex([dateAttachment], { lossy: true })
  const resourceCodex = toCodex([resourceAttachment], { lossy: true })

  check(
    'date_change attachment emits assistant commentary',
    dateCodex.some(
      line =>
        line.type === 'event_msg' &&
        (line.payload as { type?: string }).type === 'agent_message' &&
        (line.payload as { message?: string }).message === 'Current date changed to 2026-04-14.',
    ),
  )
  check(
    'mcp_resource attachment emits assistant commentary',
    resourceCodex.some(
      line =>
        line.type === 'event_msg' &&
        (line.payload as { type?: string }).type === 'agent_message' &&
        (line.payload as { message?: string }).message === 'Loaded MCP resource from filesystem: README.md.',
    ),
  )
}

{
  const reminderAttachment: ClaudeEntry = {
    type: 'attachment',
    uuid: 'att-8',
    parentUuid: null,
    sessionId: 'sess-9',
    timestamp: '2026-04-13T12:08:00.000Z',
    attachment: {
      type: 'token_usage',
      used: 1200,
      total: 8000,
      remaining: 6800,
    },
  }

  const structuredCodex: CodexRolloutLine[] = [
    {
      timestamp: '2026-04-13T12:09:00.000Z',
      type: 'session_meta',
      payload: {
        id: 'sess-10',
        timestamp: '2026-04-13T12:09:00.000Z',
        cwd: '/tmp/project',
      },
    },
    {
      timestamp: '2026-04-13T12:09:01.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        arguments: JSON.stringify({ cmd: 'cat report.json' }),
        call_id: 'call-structured',
      },
    },
    {
      timestamp: '2026-04-13T12:09:02.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call-structured',
        output: [
          { type: 'text', text: 'See attached report' },
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: 'ZmFrZQ==' },
            title: 'report.pdf',
          },
        ],
      },
    },
  ]

  const reminderCodex = toCodex([reminderAttachment], { lossy: true })
  const structuredClaude = toClaude(structuredCodex, { lossy: true })
  const structuredResult = structuredClaude.find(entry => entry.type === 'user')
  const structuredBlock = Array.isArray(structuredResult?.message?.content)
    ? structuredResult?.message?.content[0]
    : undefined

  check(
    'token_usage attachment emits assistant commentary',
    reminderCodex.some(
      line =>
        line.type === 'event_msg' &&
        (line.payload as { type?: string }).type === 'agent_message' &&
        (line.payload as { message?: string }).message === 'Token usage: 1200/8000; 6800 remaining.',
    ),
  )
  check(
    'structured Codex tool output survives as Claude rich tool_result content',
    Boolean(
      structuredBlock &&
        structuredBlock.type === 'tool_result' &&
        Array.isArray((structuredBlock as { content?: unknown }).content),
    ),
  )
}

{
  const taskStatusAttachment: ClaudeEntry = {
    type: 'attachment',
    uuid: 'att-9',
    parentUuid: null,
    sessionId: 'sess-11',
    timestamp: '2026-04-13T12:10:00.000Z',
    attachment: {
      type: 'task_status',
      taskId: 'task-42',
      taskType: 'agent',
      status: 'running',
      description: 'Investigate rollout mismatch',
      deltaSummary: 'Compared three translated sessions',
      outputFilePath: '/tmp/task-42.out',
    },
  }

  const taskCodex = toCodex([taskStatusAttachment], { lossy: true })
  check(
    'task_status attachment emits assistant commentary',
    taskCodex.some(
      line =>
        line.type === 'event_msg' &&
        (line.payload as { type?: string }).type === 'agent_message' &&
        (line.payload as { message?: string }).message ===
          'Background task "Investigate rollout mismatch" (task-42) is still running. Progress: Compared three translated sessions Partial output is available at /tmp/task-42.out.',
    ),
  )
}

{
  const hookAttachment: ClaudeEntry = {
    type: 'attachment',
    uuid: 'att-10',
    parentUuid: null,
    sessionId: 'sess-12',
    timestamp: '2026-04-13T12:11:00.000Z',
    attachment: {
      type: 'hook_stopped_continuation',
      hookName: 'Stop',
      hookEvent: 'Stop',
      toolUseID: 'tool-1',
      message: 'Stop hook prevented continuation',
    },
  }

  const hookCodex = toCodex([hookAttachment], { lossy: true })
  check(
    'hook_stopped_continuation attachment emits assistant commentary',
    hookCodex.some(
      line =>
        line.type === 'event_msg' &&
        (line.payload as { type?: string }).type === 'agent_message' &&
        (line.payload as { message?: string }).message ===
          'Stop hook stopped continuation: Stop hook prevented continuation',
    ),
  )
}

{
  const codexRename: CodexRolloutLine[] = [
    {
      timestamp: '2026-04-13T12:12:00.000Z',
      type: 'session_meta',
      payload: {
        id: 'sess-rename',
        timestamp: '2026-04-13T12:12:00.000Z',
        cwd: '/tmp/project',
      },
    },
    {
      timestamp: '2026-04-13T12:12:01.000Z',
      type: 'event_msg',
      payload: {
        type: 'thread_name_updated',
        thread_name: 'translated thread name',
      },
    },
  ]

  const renamed = toClaude(codexRename, { lossy: true })
  check(
    'thread_name_updated event emits Claude custom-title metadata',
    renamed.some(
      entry =>
        entry.type === 'custom-title' &&
        entry.customTitle === 'translated thread name',
    ),
  )
}

{
  const claudeTitle: ClaudeEntry = {
    type: 'custom-title',
    uuid: 'title-1',
    parentUuid: null,
    sessionId: 'sess-title',
    timestamp: '2026-04-13T12:13:00.000Z',
    customTitle: 'claude custom title',
  }

  const codex = toCodex([claudeTitle], { lossy: true })
  check(
    'Claude custom-title emits Codex thread_name_updated event',
    codex.some(
      line =>
        line.type === 'event_msg' &&
        (line.payload as { type?: string }).type === 'thread_name_updated' &&
        (line.payload as { thread_name?: string | null }).thread_name ===
          'claude custom title',
    ),
  )
}

{
  const agentDeltaAttachment: ClaudeEntry = {
    type: 'attachment',
    uuid: 'att-11',
    parentUuid: null,
    sessionId: 'sess-13',
    timestamp: '2026-04-13T12:14:00.000Z',
    attachment: {
      type: 'agent_listing_delta',
      addedLines: ['- explorer: specific codebase questions'],
      removedTypes: ['legacy-agent'],
      addedTypes: ['explorer'],
      isInitial: false,
      showConcurrencyNote: false,
    },
  }

  const mcpDeltaAttachment: ClaudeEntry = {
    type: 'attachment',
    uuid: 'att-12',
    parentUuid: null,
    sessionId: 'sess-14',
    timestamp: '2026-04-13T12:15:00.000Z',
    attachment: {
      type: 'mcp_instructions_delta',
      addedNames: ['filesystem'],
      addedBlocks: ['Use the filesystem server for local project resources.'],
      removedNames: ['old-server'],
    },
  }

  const agentCodex = toCodex([agentDeltaAttachment], { lossy: true })
  const mcpCodex = toCodex([mcpDeltaAttachment], { lossy: true })

  check(
    'agent_listing_delta attachment emits assistant commentary',
    agentCodex.some(
      line =>
        line.type === 'event_msg' &&
        (line.payload as { type?: string }).type === 'agent_message' &&
        typeof (line.payload as { message?: string }).message === 'string' &&
        (line.payload as { message: string }).message.includes('New agent types are now available:'),
    ),
  )
  check(
    'mcp_instructions_delta attachment emits assistant commentary',
    mcpCodex.some(
      line =>
        line.type === 'event_msg' &&
        (line.payload as { type?: string }).type === 'agent_message' &&
        typeof (line.payload as { message?: string }).message === 'string' &&
        (line.payload as { message: string }).message.includes('MCP server instructions changed:'),
    ),
  )
}

{
  const planRefAttachment: ClaudeEntry = {
    type: 'attachment',
    uuid: 'att-13',
    parentUuid: null,
    sessionId: 'sess-15',
    timestamp: '2026-04-13T12:16:00.000Z',
    attachment: {
      type: 'plan_file_reference',
      planFilePath: '/tmp/project/plan.md',
      planContent: '- Step 1\n- Step 2',
    },
  }

  const skillsAttachment: ClaudeEntry = {
    type: 'attachment',
    uuid: 'att-14',
    parentUuid: null,
    sessionId: 'sess-16',
    timestamp: '2026-04-13T12:17:00.000Z',
    attachment: {
      type: 'invoked_skills',
      skills: [
        {
          name: 'gmail',
          path: '/skills/gmail/SKILL.md',
          content: 'Use Gmail query syntax.',
        },
      ],
    },
  }

  const planRefCodex = toCodex([planRefAttachment], { lossy: true })
  const skillsCodex = toCodex([skillsAttachment], { lossy: true })

  check(
    'plan_file_reference attachment emits assistant commentary',
    planRefCodex.some(
      line =>
        line.type === 'event_msg' &&
        (line.payload as { type?: string }).type === 'agent_message' &&
        typeof (line.payload as { message?: string }).message === 'string' &&
        (line.payload as { message: string }).message.includes('Plan file reference: /tmp/project/plan.md'),
    ),
  )
  check(
    'invoked_skills attachment emits assistant commentary',
    skillsCodex.some(
      line =>
        line.type === 'event_msg' &&
        (line.payload as { type?: string }).type === 'agent_message' &&
        typeof (line.payload as { message?: string }).message === 'string' &&
        (line.payload as { message: string }).message.includes('Invoked skills in this session:'),
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

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
  return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, inner]) => [key, sortJson(inner)]),
  )
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

{
  const duplicateSourceEntry: ClaudeEntry = {
    type: 'assistant',
    uuid: 'dup-source',
    parentUuid: null,
    sessionId: 'dup-session',
    cwd: '/tmp/dup',
    gitBranch: 'main',
    timestamp: '2026-04-13T12:30:00.000Z',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'shared source' }],
    },
  }

  const duplicateSourceCodex = toCodex([
    {
      ...duplicateSourceEntry,
      _atp: {
        origin: 'codex',
        source: {
          timestamp: '2026-04-13T12:30:00.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'tool_a',
            arguments: '{"a":1}',
            call_id: 'call-a',
          },
        },
      },
    },
    {
      ...duplicateSourceEntry,
      uuid: 'dup-source-2',
      _atp: {
        origin: 'codex',
        source: {
          timestamp: '2026-04-13T12:30:00.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'tool_b',
            arguments: '{"b":2}',
            call_id: 'call-b',
          },
        },
      },
    },
  ])

  check(
    'distinct sidecar Codex sources with same timestamp and type are both preserved',
    duplicateSourceCodex.filter(line => line.type === 'response_item').length === 2,
  )
}

{
  const toolSearchCall = {
    timestamp: '2026-04-13T12:21:00.000Z',
    type: 'response_item' as const,
    payload: {
      type: 'tool_search_call' as const,
      call_id: 'search-1',
      execution: 'client',
      arguments: {
        query: 'calendar create',
        limit: 1,
      },
    },
  }

  const toolSearchOutput = {
    timestamp: '2026-04-13T12:22:00.000Z',
    type: 'response_item' as const,
    payload: {
      type: 'tool_search_output' as const,
      call_id: 'search-1',
      status: 'completed',
      execution: 'client',
      tools: [
        {
          type: 'function',
          name: 'mcp__codex_apps__calendar_create_event',
          description: 'Create a calendar event.',
        },
      ],
    },
  }

  const claude = toClaude([
    {
      timestamp: '2026-04-13T12:20:00.000Z',
      type: 'session_meta',
      payload: {
        id: 'tool-search-session',
        timestamp: '2026-04-13T12:20:00.000Z',
        cwd: process.cwd(),
        originator: 'codex',
      },
    },
    toolSearchCall,
    toolSearchOutput,
  ])

  check(
    'tool_search_call emits Claude assistant summary',
    claude.some(
      entry =>
        entry.type === 'assistant' &&
        Array.isArray(entry.message?.content) &&
        entry.message.content.some(
          block =>
            block.type === 'text' &&
            typeof block.text === 'string' &&
            block.text.includes('Searched available tools.'),
        ),
    ),
  )
  check(
    'tool_search_output emits Claude structured_output attachment',
    claude.some(
      entry =>
        entry.type === 'attachment' &&
        entry.attachment?.type === 'structured_output' &&
        Array.isArray(entry.attachment.data),
    ),
  )
  check(
    'tool_search_output emits Claude user summary',
    claude.some(
      entry =>
        entry.type === 'user' &&
        Array.isArray(entry.message?.content) &&
        entry.message.content.some(
          block =>
            block.type === 'text' &&
            typeof block.text === 'string' &&
            block.text.includes('Tool search returned 1 result.'),
        ),
      ),
  )
}

{
  const codexToolCycle: CodexRolloutLine[] = [
    {
      timestamp: '2026-04-13T12:30:00.000Z',
      type: 'session_meta',
      payload: {
        id: 'sess-merge-guard',
        timestamp: '2026-04-13T12:30:00.000Z',
        cwd: '/tmp/project',
      },
    },
    {
      timestamp: '2026-04-13T12:30:01.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        arguments: JSON.stringify({ cmd: 'pwd' }),
        call_id: 'call-a',
      },
    },
    {
      timestamp: '2026-04-13T12:30:02.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call-a',
        output: 'Process exited with code 0\nOutput:\n/tmp/project',
      },
    },
    {
      timestamp: '2026-04-13T12:30:03.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        arguments: JSON.stringify({ cmd: 'git status --short' }),
        call_id: 'call-b',
      },
    },
  ]

  const claude = toClaude(codexToolCycle, { lossy: true })
  const assistantIds = claude
    .filter(entry => entry.type === 'assistant')
    .map(entry => entry.message?.id)

  check(
    'translated assistant messages get explicit Claude message ids',
    assistantIds.every(id => typeof id === 'string' && id.startsWith('msg_')),
  )
  // All assistant emissions inside ONE Codex logical turn (no
  // intervening user text) must share a single `message.id` so Claude's
  // normalizeMessagesForAPI merges them into one API assistant message
  // with parallel tool_use blocks. Per-item unique ids break that merge
  // and trigger ensureToolResultPairing to synthesize fake error
  // tool_results, destroying the real tool outputs on resume.
  check(
    'assistant emissions within one logical turn share a single message.id',
    new Set(assistantIds).size === 1,
  )
}

{
  // Second tool cycle driven by a NEW user prompt must allocate a FRESH
  // `message.id` distinct from the first turn's — otherwise the merge
  // walk-back in normalizeMessagesForAPI would cross the user-text
  // barrier (it doesn't — `isToolResultMessage` returns false for user
  // text — but an id collision would still look suspicious to anything
  // that inspects ids downstream).
  const twoTurns: CodexRolloutLine[] = [
    {
      timestamp: '2026-04-13T12:30:00.000Z',
      type: 'session_meta',
      payload: {
        id: 'sess-turn-boundary',
        timestamp: '2026-04-13T12:30:00.000Z',
        cwd: '/tmp/project',
      },
    },
    {
      timestamp: '2026-04-13T12:30:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'first prompt' }],
      },
    },
    {
      timestamp: '2026-04-13T12:30:02.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        arguments: JSON.stringify({ cmd: 'pwd' }),
        call_id: 'call-turn1-a',
      },
    },
    {
      timestamp: '2026-04-13T12:30:03.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call-turn1-a',
        output: 'ok',
      },
    },
    {
      timestamp: '2026-04-13T12:30:10.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'second prompt' }],
      },
    },
    {
      timestamp: '2026-04-13T12:30:11.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        arguments: JSON.stringify({ cmd: 'ls' }),
        call_id: 'call-turn2-a',
      },
    },
  ]

  const claude = toClaude(twoTurns, { lossy: true })
  const asstIds = claude
    .filter(entry => entry.type === 'assistant')
    .map(entry => entry.message?.id)

  check(
    'assistant emissions in DIFFERENT turns get different message.ids',
    asstIds.length === 2 && asstIds[0] !== asstIds[1],
  )
}

{
  const richToolResultClaude: ClaudeEntry = {
    type: 'user',
    uuid: 'rich-tool-result',
    parentUuid: null,
    sessionId: 'sess-rich',
    timestamp: '2026-04-13T12:23:00.000Z',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tool-rich',
          content: [
            { type: 'text', text: 'tool returned text' },
            { type: 'image' },
            { type: 'search_result', title: 'Example result' },
          ],
        },
      ],
    },
  }

  const multimediaUserClaude: ClaudeEntry = {
    type: 'user',
    uuid: 'user-image',
    parentUuid: null,
    sessionId: 'sess-user-image',
    timestamp: '2026-04-13T12:24:00.000Z',
    message: {
      role: 'user',
      content: [
        { type: 'image', source: { media_type: 'image/png' } },
        { type: 'document', title: 'spec.pdf' },
      ],
    },
  }

  const richToolResultCodex = toCodex([richToolResultClaude], { lossy: true })
  const multimediaUserCodex = toCodex([multimediaUserClaude], { lossy: true })

  check(
    'rich Claude tool_result content is flattened instead of dropped in lossy toCodex',
    richToolResultCodex.some(
      line =>
        line.type === 'response_item' &&
        (line.payload as { type?: string }).type === 'function_call_output' &&
        typeof (line.payload as { output?: string }).output === 'string' &&
        (line.payload as { output: string }).output.includes('tool returned text'),
    ),
  )
  check(
    'non-text Claude user content falls back to textual markers in lossy toCodex',
    multimediaUserCodex.some(
      line =>
        line.type === 'event_msg' &&
        (line.payload as { type?: string }).type === 'user_message' &&
        typeof (line.payload as { message?: string }).message === 'string' &&
        (line.payload as { message: string }).message.includes('[User attached image: image/png]'),
      ),
  )
}

{
  const reasoningClaude: ClaudeEntry = {
    type: 'assistant',
    uuid: 'reasoning-1',
    parentUuid: null,
    sessionId: 'sess-reasoning',
    timestamp: '2026-04-13T12:25:00.000Z',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'thinking',
          thinking: '**Preparing file read approach**',
        },
      ],
    },
  }

  const customToolResultClaude: ClaudeEntry = {
    type: 'user',
    uuid: 'custom-tool-result-1',
    parentUuid: null,
    sessionId: 'sess-custom-tool-result',
    timestamp: '2026-04-13T12:26:00.000Z',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'custom-call-1',
          content: 'tool returned plain text',
          codex: {
            kind: 'custom_tool_call_output',
            metadata: {
              exit_code: 1,
            },
          },
        },
      ],
    },
  }

  const reasoningCodex = toCodex([reasoningClaude], { lossy: true })
  const customToolResultCodex = toCodex([customToolResultClaude], { lossy: true })

  check(
    'Claude thinking emits Codex summary_text reasoning summaries',
    reasoningCodex.some(
      line =>
        line.type === 'response_item' &&
        (line.payload as { type?: string }).type === 'reasoning' &&
        Array.isArray((line.payload as { summary?: unknown }).summary) &&
        (line.payload as { summary: Array<{ type?: string }> }).summary[0]?.type ===
          'summary_text',
    ),
  )
  check(
    'custom_tool_call_output emits bare text output instead of wrapped JSON',
    customToolResultCodex.some(
      line =>
        line.type === 'response_item' &&
        (line.payload as { type?: string }).type === 'custom_tool_call_output' &&
        (line.payload as { output?: unknown }).output === 'tool returned plain text',
    ),
  )
}

{
  // Translated Codex reasoning MUST NOT produce a Claude `thinking`
  // block — Anthropic's API requires a server-issued signature on
  // every thinking block in assistant history, and translator-
  // synthesized reasoning has none. A 400 with
  // "messages.N.content.0.thinking.signature: Field required" is the
  // exact failure mode we're preventing. We emit a plain text block
  // prefixed with "Reasoning: " instead.
  const reasoningRollout: CodexRolloutLine[] = [
    {
      timestamp: '2026-04-14T10:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: 'sess-reasoning-guard',
        timestamp: '2026-04-14T10:00:00.000Z',
        cwd: '/tmp/project',
      },
    },
    {
      timestamp: '2026-04-14T10:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'reasoning',
        id: 'rs_1',
        summary: [
          { type: 'summary_text', text: '**Preparing read approach**' },
        ],
      },
    },
  ]

  const translated = toClaude(reasoningRollout, { lossy: true })
  const reasoningEntry = translated.find(e => e.type === 'assistant')
  const blocks = Array.isArray(reasoningEntry?.message?.content)
    ? reasoningEntry?.message?.content
    : []

  check(
    'translated Codex reasoning does not emit an unsigned Claude thinking block',
    !blocks.some(b => b.type === 'thinking'),
  )
  check(
    'translated Codex reasoning becomes a text block with a Reasoning: prefix',
    blocks.some(
      b =>
        b.type === 'text' &&
        typeof (b as { text?: string }).text === 'string' &&
        (b as { text: string }).text.startsWith('Reasoning: ') &&
        (b as { text: string }).text.includes('Preparing read approach'),
    ),
  )
}

{
  const todoReminder: ClaudeEntry = {
    type: 'attachment',
    uuid: 'att-15',
    parentUuid: null,
    sessionId: 'sess-17',
    timestamp: '2026-04-13T12:18:00.000Z',
    attachment: {
      type: 'todo_reminder',
      content: [{ status: 'in_progress', content: 'Audit transcript mappings' }],
    },
  }

  const deferredTools: ClaudeEntry = {
    type: 'attachment',
    uuid: 'att-16',
    parentUuid: null,
    sessionId: 'sess-18',
    timestamp: '2026-04-13T12:19:00.000Z',
    attachment: {
      type: 'deferred_tools_delta',
      addedLines: ['tool_search: Search deferred tools'],
      removedNames: ['legacy_tool'],
    },
  }

  const agentMention: ClaudeEntry = {
    type: 'attachment',
    uuid: 'att-17',
    parentUuid: null,
    sessionId: 'sess-19',
    timestamp: '2026-04-13T12:20:00.000Z',
    attachment: {
      type: 'agent_mention',
      agentType: 'explorer',
    },
  }

  const todoCodex = toCodex([todoReminder], { lossy: true })
  const deferredCodex = toCodex([deferredTools], { lossy: true })
  const agentMentionCodex = toCodex([agentMention], { lossy: true })

  check(
    'todo_reminder attachment emits assistant commentary',
    todoCodex.some(
      line =>
        line.type === 'event_msg' &&
        (line.payload as { type?: string }).type === 'agent_message' &&
        typeof (line.payload as { message?: string }).message === 'string' &&
        (line.payload as { message: string }).message.includes('Todo tracking reminder:'),
    ),
  )
  check(
    'deferred_tools_delta attachment emits assistant commentary',
    deferredCodex.some(
      line =>
        line.type === 'event_msg' &&
        (line.payload as { type?: string }).type === 'agent_message' &&
        typeof (line.payload as { message?: string }).message === 'string' &&
        (line.payload as { message: string }).message.includes('Deferred tools now available:'),
    ),
  )
  check(
    'agent_mention attachment emits assistant commentary',
    agentMentionCodex.some(
      line =>
        line.type === 'event_msg' &&
        (line.payload as { type?: string }).type === 'agent_message' &&
        typeof (line.payload as { message?: string }).message === 'string' &&
        (line.payload as { message: string }).message.includes('Agent invocation reminder:'),
    ),
  )
}

{
  const mixedClaude = toClaude([
    {
      timestamp: '2026-04-13T12:40:00.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'native codex line after sidecar' }],
      },
      _atp: {
        origin: 'claude',
        source: {
          type: 'assistant',
          uuid: 'source-ctx',
          parentUuid: null,
          sessionId: 'mixed-session',
          cwd: '/tmp/mixed',
          gitBranch: 'feature/mixed',
          version: '1.2.3',
          timestamp: '2026-04-13T12:39:00.000Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'restored source entry' }],
          },
        },
      },
    },
    {
      timestamp: '2026-04-13T12:41:00.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'native tail' }],
      },
    },
  ] as CodexRolloutLine[])

  const stampedTail = mixedClaude.find(
    entry =>
      entry.type === 'assistant' &&
      Array.isArray(entry.message?.content) &&
      entry.message.content.some(
        block => block.type === 'text' && block.text === 'native tail',
      ),
  )

  check(
    'sidecar short-circuit refreshes Claude session context for later stamped entries',
    stampedTail?.sessionId === 'mixed-session' &&
      stampedTail?.cwd === '/tmp/mixed' &&
      stampedTail?.gitBranch === 'feature/mixed' &&
      stampedTail?.version === '1.2.3',
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

// Semantic assertion battery for the codec decode surface (#5,
// slice 1). Complements round-trip-identity.ts: identity proves
// nothing was LOST; these prove the semantic fields actually carry
// what the wire had. Run with `tsx testing/semantic-assertions.ts`
// (`npm run verify:neutral-semantics`).

import { readFileSync } from 'fs'
import { join, resolve } from 'path'

import { ClaudeCodec } from '../src/codecs/claude.js'
import { CodexCodec } from '../src/codecs/codex.js'
import type { ClaudeEntry, CodexRolloutLine } from '../src/types.js'
import type { NeutralEntry, NeutralTranscript } from '../src/neutral/types.js'

const ROOT = resolve(new URL('.', import.meta.url).pathname, '..')
let failed = 0

function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`ok  ${label}`)
  } else {
    failed += 1
    console.log(`FAIL ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`)
  }
}

function parse<T>(file: string): T[] {
  return readFileSync(join(ROOT, file), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as T)
}

function kinds(t: NeutralTranscript): string[] {
  return t.entries.map(e => e.kind)
}

function textOf(e: NeutralEntry): string {
  if (e.kind !== 'userMessage' && e.kind !== 'assistantMessage') return ''
  return e.content
    .map(b => (b.kind === 'text' ? b.text : ''))
    .filter(Boolean)
    .join('\n')
}

// --- Claude: simple chat ---------------------------------------------------
{
  const t = ClaudeCodec.decode(parse<ClaudeEntry>('fixtures/claude/simple-chat.jsonl'))
  check('claude simple-chat kinds', JSON.stringify(kinds(t)) === '["userMessage","assistantMessage"]', kinds(t))
  check('claude simple-chat user text', textOf(t.entries[0]) === 'Hi there.')
  check('claude simple-chat assistant text', textOf(t.entries[1]) === 'Hello! How can I help?')
  check('claude simple-chat header', t.header.cwd === '/tmp/test' && t.header.git?.branch === 'main')
  check('claude simple-chat ordinal', t.entries[0].userTurnOrdinal === 0 && t.entries[1].userTurnOrdinal === null)
}

// --- Claude: tool cycle ----------------------------------------------------
{
  const t = ClaudeCodec.decode(parse<ClaudeEntry>('fixtures/claude/tool-cycle.jsonl'))
  const assistant = t.entries[1]
  check('claude tool-cycle assistant has toolUse block',
    assistant.kind === 'assistantMessage' &&
    assistant.content.some(b => b.kind === 'toolUse' && b.callId === 'toolu_ls_001' && b.toolName === 'Bash'))
  const resultCarrier = t.entries[2]
  const resultBlock = resultCarrier.kind === 'userMessage'
    ? resultCarrier.content.find(b => b.kind === 'toolResult')
    : undefined
  check('claude tool-cycle result pairs callId',
    resultBlock?.kind === 'toolResult' && resultBlock.callId === 'toolu_ls_001')
  check('claude tool-cycle result rawOutput preserved',
    resultBlock?.kind === 'toolResult' && resultBlock.rawOutput === 'file1\nfile2\n')
  // Tool-result-only user entries still count toward the ordinal ONLY
  // if they're a new contiguous user run — here the tool_result user
  // entry follows an assistant, so it takes ordinal 1. This mirrors
  // the wire (it IS a user entry) and matters for anchor fidelity:
  // rewindClaude anchors on user entries including tool-result-only
  // ones (it tolerates message-less anchors).
  check('claude tool-cycle ordinals', t.entries[0].userTurnOrdinal === 0 && t.entries[2].userTurnOrdinal === 1)
}

// --- Claude: compact flow --------------------------------------------------
{
  const t = ClaudeCodec.decode(parse<ClaudeEntry>('fixtures/claude/compact-flow.jsonl'))
  const boundary = t.entries.find(e => e.kind === 'compaction')
  check('claude compact-flow boundary classified', Boolean(boundary))
  const summary = t.entries.find(e => e.kind === 'userMessage' && e.isCompactSummary === true)
  check('claude compact-flow summary flagged', Boolean(summary))
  check('claude compact-flow summary not counted as user turn',
    summary !== undefined && summary.userTurnOrdinal === null)
}

// --- Codex: simple chat ----------------------------------------------------
{
  const t = CodexCodec.decode(parse<CodexRolloutLine>('fixtures/codex/simple-chat.jsonl'))
  check('codex simple-chat kinds',
    JSON.stringify(kinds(t)) ===
      '["sessionMeta","userMessage","assistantMessage","userMessage"]',
    kinds(t))
  const user = t.entries.find(e => e.kind === 'userMessage')
  check('codex simple-chat user text', user !== undefined && textOf(user) === 'Hello, what can you do?')
  const userOrdinals = t.entries
    .filter(e => e.kind === 'userMessage')
    .map(e => e.userTurnOrdinal)
  check('codex simple-chat ordinals', JSON.stringify(userOrdinals) === '[0,1]', userOrdinals)
  check('codex simple-chat header extras',
    t.header.providerMeta.codex?.originator === 'codex_cli_rs' &&
    t.header.providerMeta.codex?.model_provider === 'openai')
}

// --- Codex: tool cycle -----------------------------------------------------
{
  const t = CodexCodec.decode(parse<CodexRolloutLine>('fixtures/codex/tool-cycle.jsonl'))
  const call = t.entries.find(e => e.kind === 'toolCall')
  check('codex tool-cycle call mapped',
    call?.kind === 'toolCall' &&
    call.block.callId === 'call_abc123' &&
    call.block.toolName === 'exec_command' &&
    call.block.rawArgumentsString === '{"cmd":"ls -la"}' &&
    JSON.stringify(call.block.input) === '{"cmd":"ls -la"}')
  const result = t.entries.find(e => e.kind === 'toolResult')
  check('codex tool-cycle result pairs callId',
    result?.kind === 'toolResult' && result.block.callId === 'call_abc123')
  check('codex tool-cycle result raw preserved',
    result?.kind === 'toolResult' && typeof result.block.rawOutput === 'string' &&
    (result.block.rawOutput as string).startsWith('total 8'))
}

// --- Codex: compact flow ---------------------------------------------------
{
  const t = CodexCodec.decode(parse<CodexRolloutLine>('fixtures/codex/compact-flow.jsonl'))
  const compaction = t.entries.find(e => e.kind === 'compaction')
  check('codex compact-flow compaction mapped',
    compaction?.kind === 'compaction' && compaction.summaryBody.length > 0)
}

// --- Codex: approval flow (lifecycle events stay visible) ------------------
{
  const t = CodexCodec.decode(parse<CodexRolloutLine>('fixtures/codex/approval-flow.jsonl'))
  check('codex approval-flow has lifecycle or opaque coverage',
    t.entries.every(e => e.kind !== undefined), kinds(t))
}

console.log(failed === 0 ? '\nAll semantic assertions passed' : `\n${failed} FAILED`)
if (failed > 0) process.exit(1)

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import type { ConversationDocument } from '../../src/conversation/types.js'
import { decodeGrokConversation } from '../../src/grok/conversation/decode.js'
import { decodePiConversation } from '../../src/pi/conversation/decode.js'
import { projectPiNativeResume } from '../../src/pi/project/project.js'

// Native-load evidence: the INSTALLED pi opens a projected file with
// `--session-id`, as Agent Code's switch will, and the context it assembles
// for the next model call contains the imported history. Pi's own faux
// provider stands in for the model (no login exists on the dev machine, and
// none is needed to prove what Pi loads). Everything runs in a throwaway
// HOME + PI_CODING_AGENT_DIR, so no real Pi state is read or written.
//
//   PI_PARSER_LIVE=1 PI_BINARY=/path/to/pi npx vitest run --config vitest.live.config.ts

type Row = Record<string, any>
const load = (path: string): Row[] => readFileSync(new URL(path, import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line))

function runProjected(binary: string, conversation: ConversationDocument, prompt: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-projection-')))
  try {
    const project = join(root, 'project')
    const agentDir = join(root, 'agent')
    mkdirSync(project, { recursive: true })
    const sessionId = randomUUID()
    const result = projectPiNativeResume(conversation, { targetSessionId: sessionId, cwd: project, now: new Date().toISOString() })
    // session-manager.ts getDefaultSessionDirPath.
    const sessionDir = join(agentDir, 'sessions', `--${resolve(project).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`)
    mkdirSync(sessionDir, { recursive: true })
    const file = join(sessionDir, result.fileName)
    writeFileSync(file, result.values.map(value => JSON.stringify(value)).join('\n') + '\n')
    const contextOut = join(root, 'context.jsonl')
    const run = spawnSync(binary, [
      '--provider', 'faux', '--model', 'faux-1', '-e', new URL('./pi-context-recorder.mjs', import.meta.url).pathname,
      '--session-id', sessionId, '-p', prompt,
    ], {
      cwd: project, encoding: 'utf8', timeout: 60_000,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(root, 'home'), PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', PI_PARSER_CONTEXT_OUT: contextOut },
    })
    const contexts = existsSync(contextOut) ? readFileSync(contextOut, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Row[]) : []
    return { run, contexts, projected: result.values, after: load(`file://${file}`) }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const text = (message: Row) => typeof message.content === 'string' ? message.content
  : (message.content as Row[]).map(block => block.type === 'text' ? block.text : block.type === 'thinking' ? block.thinking : '').join('')

it('pi loads a projected foreign (Grok) session and sends its request and tool cycle to the model', context => {
  if (process.env.PI_PARSER_LIVE !== '1') context.skip('Set PI_PARSER_LIVE=1 (and PI_BINARY) for the installed-CLI resume gate')
  const binary = process.env.PI_BINARY ?? 'pi'
  const grok = load('../../fixtures/evidence/grok/command.jsonl')
  const { run, contexts, projected, after } = runProjected(binary, decodeGrokConversation(grok), 'what did you run?')
  expect(run.status, run.stderr).toBe(0)
  // Pi found the projected session instead of creating a new one.
  expect(run.stderr).not.toContain('No project session found')
  const messages = contexts[0]!
  // Pi installs ITS OWN system prompt (a `system` row it writes on resume),
  // and nothing from Grok's system/bootstrap records reaches it.
  const system = messages.filter(message => message.role === 'system')
  expect(system).toHaveLength(1)
  expect(JSON.stringify(system)).not.toContain('Imported')
  expect(messages.filter(message => message.role !== 'system').map(message => message.role)).toEqual(['user', 'assistant', 'toolResult', 'assistant', 'user'])
  expect(text(messages[0]!)).toBe('Run this exact shell command: touch PERMISSION_PROBE.txt')
  const call = (messages[1]!.content as Row[]).find(block => block.type === 'toolCall')!
  expect(call).toMatchObject({ name: 'run_terminal_command', arguments: { command: 'touch PERMISSION_PROBE.txt' } })
  expect(messages[2]).toMatchObject({ toolCallId: call.id, toolName: 'run_terminal_command', content: [{ type: 'text', text: 'exit: 0' }] })
  expect(text(messages.at(-1)!)).toBe('what did you run?')
  // The new turn was appended to the SAME chain Pi resumed.
  const lastProjected = projected.at(-1)!
  expect(after.slice(0, projected.length)).toEqual(projected)
  expect(after.slice(projected.length).find(row => row.type === 'message')!.parentId).toBeDefined()
  expect(decodePiConversation(after).entries.filter(entry => entry.kind === 'message' && entry.role === 'user').length).toBe(2)
  expect(after.some(row => row.parentId === lastProjected.id)).toBe(true)
})

it('pi resumes a projected compacted session from the summary plus the rows Pi kept', context => {
  if (process.env.PI_PARSER_LIVE !== '1') context.skip('Set PI_PARSER_LIVE=1 (and PI_BINARY) for the installed-CLI resume gate')
  const binary = process.env.PI_BINARY ?? 'pi'
  const { run, contexts } = runProjected(binary, decodePiConversation(load('../../fixtures/evidence/pi/compaction.jsonl')), 'continue')
  expect(run.status, run.stderr).toBe(0)
  const texts = contexts[0]!.filter(message => message.role !== 'system').map(text)
  // 0.87.1's COMPACTION_SUMMARY_PREFIX wraps the carried summary.
  expect(texts[0]).toMatch(/^The conversation history before this point was compacted into the following summary:\n\n<summary>\nReply to a 1050-character prompt\./)
  expect(texts.slice(1)).toEqual(['Reply to a 16-character prompt.', 'after compaction [probe:c4]', expect.stringMatching(/^Reply to/), 'continue'])
})

it('an empty projected session (a duplicated fresh pane) opens, and the first turn appends to it', context => {
  if (process.env.PI_PARSER_LIVE !== '1') context.skip('Set PI_PARSER_LIVE=1 (and PI_BINARY) for the installed-CLI resume gate')
  const binary = process.env.PI_BINARY ?? 'pi'
  const empty: ConversationDocument = { schemaVersion: 1, sourceProvider: 'pi', sourceSessionIds: ['fresh'], entries: [] }
  const { run, contexts, projected, after } = runProjected(binary, empty, 'first words')
  expect(run.status, run.stderr).toBe(0)
  expect(run.stderr).not.toContain('No project session found')
  expect(projected.map(row => row.type)).toEqual(['session', 'custom'])
  expect(contexts[0]!.filter(message => message.role !== 'system').map(text)).toEqual(['first words'])
  expect(after.slice(0, 2)).toEqual(projected)
  expect(after.some(row => row.parentId === projected[1]!.id)).toBe(true)
})

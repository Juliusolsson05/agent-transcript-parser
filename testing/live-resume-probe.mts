#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'

import * as pty from 'node-pty'

import { ClaudeCodeHeadless } from '../../claude-code-headless/src/index.ts'
import { CodexHeadless } from '../../codex-headless/src/index.ts'
import {
  classifyClaudeDocument,
  classifyCodexDocument,
  decodeClaudeConversation,
  decodeCodexConversation,
  decodeJsonl,
  describeLatestCompaction,
  fitConversationToCharacterBudget,
  planConversationContext,
  projectClaudeNativeResume,
  projectCodexNativeResume,
  resolveCodexTargetProfileFromSources,
} from '../src/index.js'
import type {
  ConversationDocument,
  NativeResumeProjectionResult,
} from '../src/index.js'

type Provider = 'claude' | 'codex'
type TargetSelection = Provider | 'both' | 'opposite'
type OversizeMode = 'compact' | 'fail' | 'truncate'

interface ProbeOptions {
  inputs: string[]
  source: Provider | 'auto'
  target: TargetSelection
  prompt: string
  timeoutMs: number
  maxFiles: number | null
  keep: boolean
  codexBinary: string
  claudeBinary: string
  codexModel: string | null
  claudeModel: string
  codexContextCharacters: number | null
  claudeContextCharacters: number
  oversizeMode: OversizeMode
}

interface PreparedProjection {
  provider: Provider
  sessionId: string
  transcriptPath: string
  workspace: string
  projection: NativeResumeProjectionResult
  cleanup: () => Promise<void>
}

interface ProbeResult {
  input: string
  source: Provider
  target: Provider
  ok: boolean
  sessionId: string | null
  transcriptPath: string | null
  workspace: string | null
  response: string | null
  error: string | null
  diagnostics: string[]
  durationMs: number
  projectionReport: {
    profile: string
    sourceProvider: string
    targetProvider: string
    counts: NativeResumeProjectionResult['report']['counts']
  } | null
  contextFit: {
    strategy: 'none' | 'existing-compaction' | 'native-compaction' | 'truncate'
    truncated: boolean
    droppedEntries: number
    estimatedCharactersBefore: number
    estimatedCharactersAfter: number
    budgetCharacters: number
  } | null
}

const DEFAULT_PROMPT =
  'Read only: using only the conversation history already loaded, briefly state what we have done in this conversation. Do not use tools or modify files.'

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2))
  if (options.inputs.length === 0) {
    printHelp()
    process.exitCode = 2
    return
  }

  const inputs = (await expandInputs(options.inputs)).slice(
    0,
    options.maxFiles ?? Number.POSITIVE_INFINITY,
  )
  if (inputs.length === 0) throw new Error('No JSONL transcript files matched the supplied inputs.')

  const results: ProbeResult[] = []
  // WHY probes are deliberately sequential: each prompt is a real paid provider
  // turn, and both CLIs keep global caches and transcript watchers under the
  // user's provider home. Concurrency would make failures harder to attribute
  // and could cause a large corpus command to create an accidental API burst.
  for (const input of inputs) {
    const source = await loadSource(input, options.source)
    for (const target of selectedTargets(options.target, source.provider)) {
      const result = await runCase(input, source.provider, source.conversation, target, options)
      results.push(result)
      process.stdout.write(`${JSON.stringify({ type: 'probe_result', ...result })}\n`)
    }
  }

  const passed = results.filter(result => result.ok).length
  const failed = results.length - passed
  process.stdout.write(`${JSON.stringify({
    type: 'probe_summary',
    files: inputs.length,
    cases: results.length,
    passed,
    failed,
  })}\n`)
  if (failed > 0) process.exitCode = 1
}

async function runCase(
  input: string,
  source: Provider,
  conversation: ConversationDocument,
  target: Provider,
  options: ProbeOptions,
): Promise<ProbeResult> {
  const startedAt = Date.now()
  const diagnostics: string[] = []
  let prepared: PreparedProjection | null = null
  let contextFit: ProbeResult['contextFit'] = null
  try {
    const budgetCharacters = target === 'codex'
      ? options.codexContextCharacters ?? await configuredCodexContextCharacters(options)
      : options.claudeContextCharacters
    const preparedConversation = await conversationForTargetBudget(
      conversation,
      source,
      target,
      budgetCharacters,
      options,
      diagnostics,
    )
    const fit = fitConversationToCharacterBudget(
      preparedConversation.conversation,
      budgetCharacters,
    )
    contextFit = {
      strategy: preparedConversation.strategy,
      truncated: fit.truncated,
      droppedEntries: fit.droppedEntries,
      estimatedCharactersBefore: fit.estimatedCharactersBefore,
      estimatedCharactersAfter: fit.estimatedCharactersAfter,
      budgetCharacters: fit.budgetCharacters,
    }
    if (fit.truncated && preparedConversation.strategy === 'truncate') {
      diagnostics.push(`context fit omitted ${fit.droppedEntries} earlier entries`)
    }
    prepared = await prepareProjection(
      preparedConversation.strategy === 'truncate'
        ? fit.conversation
        : preparedConversation.conversation,
      target,
      options,
    )
    const marker = `ATP_LIVE_PROBE_${randomUUID()}`
    const prompt = `${options.prompt} End your response with exactly ${marker}.`
    const response = target === 'codex'
      ? await runCodex(prepared, prompt, marker, options, diagnostics)
      : await runClaude(prepared, prompt, marker, options, diagnostics)
    return result(true, null, response)
  } catch (error) {
    return result(false, error instanceof Error ? error.message : String(error), null)
  } finally {
    if (prepared && !options.keep) {
      try {
        await prepared.cleanup()
      } catch (error) {
        // Cleanup is diagnostic hygiene, not the provider verdict. A late CLI
        // sidecar write must not replace a successful response or the real API
        // error we spent a paid turn obtaining.
        diagnostics.push(`cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  function result(ok: boolean, error: string | null, response: string | null): ProbeResult {
    return {
      input,
      source,
      target,
      ok,
      sessionId: prepared?.sessionId ?? null,
      transcriptPath: prepared?.transcriptPath ?? null,
      workspace: prepared?.workspace ?? null,
      response,
      error,
      diagnostics,
      durationMs: Date.now() - startedAt,
      projectionReport: prepared ? summarizeReport(prepared.projection.report) : null,
      contextFit,
    }
  }
}

async function prepareProjection(
  conversation: ConversationDocument,
  provider: Provider,
  options: ProbeOptions,
): Promise<PreparedProjection> {
  const sessionId = randomUUID()
  const now = new Date().toISOString()
  const workspaceAlias = await mkdtemp(join(tmpdir(), `atp-live-${provider}-`))
  const workspace = (await realpath(workspaceAlias)).normalize('NFC')

  if (provider === 'codex') {
    const codexModel = (await configuredCodexTargetProfile(options)).model
    const projection = projectCodexNativeResume(conversation, {
      targetSessionId: sessionId,
      now,
      cwd: workspace,
      cliVersion: binaryVersion(options.codexBinary, /^codex-cli\s+/),
      modelProvider: 'openai',
      model: codexModel,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'read-only' },
    })
    const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex')
    const [year, month, day] = now.slice(0, 10).split('-') as [string, string, string]
    const timestamp = now.replace(/:/g, '-').replace(/\.\d{3}Z$/, '')
    const transcriptPath = join(
      codexHome,
      'sessions',
      year,
      month,
      day,
      `rollout-${timestamp}-${sessionId}.jsonl`,
    )
    await mkdir(dirname(transcriptPath), { recursive: true })
    await writeProjection(transcriptPath, projection)
    return {
      provider,
      sessionId,
      transcriptPath,
      workspace,
      projection,
      async cleanup() {
        // WHY cleanup matches the unique throwaway cwd rather than deleting every
        // rollout created after probe start: Codex may fork a resumed rollout, and
        // the user may run unrelated real sessions concurrently. The embedded cwd
        // identifies every probe fork without touching neighboring user sessions.
        await removeCodexRolloutsForWorkspace(join(codexHome, 'sessions'), workspace, sessionId)
        await removeProbeDirectory(workspace)
      },
    }
  }

  const projection = projectClaudeNativeResume(conversation, {
    targetSessionId: sessionId,
    now,
    cwd: workspace,
    version: binaryVersion(options.claudeBinary),
    model: options.claudeModel,
  })
  const claudeHome = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  const projectDir = join(claudeHome, 'projects', sanitizeClaudePath(workspace))
  const transcriptPath = join(projectDir, `${sessionId}.jsonl`)
  await mkdir(projectDir, { recursive: true })
  await writeProjection(transcriptPath, projection)
  return {
    provider,
    sessionId,
    transcriptPath,
    workspace,
    projection,
    async cleanup() {
      // The workspace is unique to this one probe, so its Claude project folder
      // cannot contain a user's pre-existing sessions. Removing the whole folder
      // also catches sidecar files Claude may create while resuming a long input.
      await removeProbeDirectory(projectDir)
      await removeProbeDirectory(workspace)
    },
  }
}

async function conversationForTargetBudget(
  conversation: ConversationDocument,
  source: Provider,
  target: Provider,
  budgetCharacters: number,
  options: ProbeOptions,
  diagnostics: string[],
): Promise<{
  conversation: ConversationDocument
  strategy: NonNullable<ProbeResult['contextFit']>['strategy']
}> {
  const initial = planConversationContext(conversation, target, budgetCharacters)
  if (initial.kind === 'ready' || initial.kind === 'existing-compaction') {
    if (initial.kind === 'existing-compaction') {
      diagnostics.push('used existing source compaction summary and post-compaction history')
    }
    return {
      conversation: initial.conversation,
      strategy: initial.kind === 'ready' ? 'none' : 'existing-compaction',
    }
  }
  if (options.oversizeMode === 'fail') {
    throw new Error(
      `Decoded conversation needs approximately ${initial.estimatedCharacters} characters, ` +
      `above the ${budgetCharacters} target budget, and has no sufficient persisted compaction.`,
    )
  }
  if (options.oversizeMode === 'truncate') {
    if (initial.kind === 'requires-portable-handoff') {
      throw new Error('Encrypted Codex compaction requires a plaintext handoff and cannot be safely truncated.')
    }
    return { conversation: initial.conversation, strategy: 'truncate' }
  }

  diagnostics.push(initial.kind === 'requires-portable-handoff'
    ? 'existing Codex compaction requires a plaintext portable handoff'
    : `source conversation exceeds target budget; requesting native ${source} compaction`)
  const compacted = await compactSourceConversation(
    conversation,
    source,
    initial.kind === 'requires-portable-handoff',
    options,
    diagnostics,
  )
  const compactedPlan = planConversationContext(compacted, target, budgetCharacters)
  if (compactedPlan.kind !== 'ready' && compactedPlan.kind !== 'existing-compaction') {
    throw new Error(
      `Native ${source} compaction persisted, but its summary plus retained history still needs ` +
      `${compactedPlan.estimatedCharacters} characters above the ${budgetCharacters} target budget. ` +
      'Rerun with --oversize-mode truncate only if explicit history loss is acceptable.',
    )
  }
  return { conversation: compactedPlan.conversation, strategy: 'native-compaction' }
}

async function compactSourceConversation(
  conversation: ConversationDocument,
  source: Provider,
  reuseNativeCompaction: boolean,
  options: ProbeOptions,
  diagnostics: string[],
): Promise<ConversationDocument> {
  const prepared = await prepareProjection(conversation, source, options)
  try {
    const compacted = source === 'codex'
      ? await compactCodexClone(prepared, reuseNativeCompaction, options, diagnostics)
      : await compactClaudeClone(prepared, options, diagnostics)
    diagnostics.push(`native ${source} compaction persisted a transferable summary`)
    return compacted
  } finally {
    if (!options.keep) await prepared.cleanup()
  }
}

async function compactCodexClone(
  prepared: PreparedProjection,
  reuseNativeCompaction: boolean,
  options: ProbeOptions,
  diagnostics: string[],
): Promise<ConversationDocument> {
  const terminal = pty.spawn(options.codexBinary, [
    '--sandbox', 'read-only', '--ask-for-approval', 'never', '--no-alt-screen',
    'resume', prepared.sessionId,
  ], terminalOptions(prepared.workspace))
  const headless = new CodexHeadless({
    pty: terminal,
    cwd: prepared.workspace,
    resumeThreadId: prepared.sessionId,
    cols: 160,
    rows: 50,
  })
  let activePath = prepared.transcriptPath
  headless.committed.on('rollout_line', event => {
    activePath = event.file
  })
  try {
    await headless.start()
    await waitForCodexReady(headless, options.timeoutMs, diagnostics)
    if (!reuseNativeCompaction) {
      await submitCodexPrompt(headless, '/compact', '/compact', diagnostics)
      await waitForPersistedCompaction(
        () => activePath,
        'codex',
        options.timeoutMs,
        () => headless.isIdle(),
      )
    } else {
      diagnostics.push('reused existing Codex native compaction without compacting twice')
    }
    await waitForCodexReady(headless, options.timeoutMs, diagnostics)
    const marker = `ATP_PORTABLE_HANDOFF_${randomUUID()}`
    const prompt = `${portableSummaryPrompt()} End your response with exactly ${marker}.`
    const response = committedResponse(headless, marker, options.timeoutMs, () => headless.getScreen())
    await submitCodexPrompt(headless, prompt, marker, diagnostics)
    const summary = (await response).replace(marker, '').trim()
    if (!summary) throw new Error('Codex completed the portable handoff turn without summary text.')
    return {
      schemaVersion: 1,
      sourceProvider: 'codex',
      sourceSessionIds: [prepared.sessionId],
      entries: [{
        kind: 'compaction',
        summary,
        summarySource: 'synthetic',
        timestamp: new Date().toISOString(),
        source: { provider: 'codex', line: 0, raw: {}, evidence: [] },
      }],
    }
  } finally {
    try { terminal.kill() } catch { /* PTY may already have exited. */ }
    await headless.stop()
  }
}

async function compactClaudeClone(
  prepared: PreparedProjection,
  options: ProbeOptions,
  diagnostics: string[],
): Promise<ConversationDocument> {
  const terminal = pty.spawn(options.claudeBinary, [
    '--resume', prepared.sessionId, '--safe-mode', '--permission-mode', 'dontAsk',
  ], terminalOptions(prepared.workspace))
  const headless = new ClaudeCodeHeadless({
    pty: terminal,
    cwd: prepared.workspace,
    resumeSessionId: prepared.sessionId,
    cols: 160,
    rows: 50,
  })
  try {
    await headless.start()
    await waitForClaudeReady(headless, options.timeoutMs, diagnostics)
    await submitClaudePrompt(headless, '/compact', '/compact', diagnostics)
    return await waitForPersistedCompaction(
      () => prepared.transcriptPath,
      'claude',
      options.timeoutMs,
      () => headless.isIdle() && headless.getComposerState() === 'empty',
    )
  } finally {
    try { terminal.kill() } catch { /* PTY may already have exited. */ }
    await headless.stop()
  }
}

async function waitForPersistedCompaction(
  path: () => string,
  provider: Provider,
  timeoutMs: number,
  isIdle: () => boolean,
): Promise<ConversationDocument> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const conversation = await readConversation(path(), provider)
      const latest = describeLatestCompaction(conversation)
      if (latest && latest.availability !== 'incomplete' && isIdle()) {
        return latest.availability === 'portable'
          ? { ...conversation, entries: conversation.entries.slice(latest.entryIndex) }
          : conversation
      }
    } catch {
      // Provider JSONL writes are append-oriented. A poll can land between bytes;
      // the next stable read is authoritative and the timeout remains bounded.
    }
    await delay(100)
  }
  throw new Error(`Timed out waiting for ${provider} /compact to persist a durable compaction.`)
}

async function readConversation(path: string, provider: Provider): Promise<ConversationDocument> {
  const document = decodeJsonl(await readFile(path, 'utf8'))
  return provider === 'codex'
    ? decodeCodexConversation(classifyCodexDocument(document).records)
    : decodeClaudeConversation(classifyClaudeDocument(document).records)
}

async function runCodex(
  prepared: PreparedProjection,
  prompt: string,
  marker: string,
  options: ProbeOptions,
  diagnostics: string[],
): Promise<string> {
  const terminal = pty.spawn(options.codexBinary, [
    '--sandbox',
    'read-only',
    '--ask-for-approval',
    'never',
    '--no-alt-screen',
    'resume',
    prepared.sessionId,
  ], terminalOptions(prepared.workspace))
  const headless = new CodexHeadless({
    pty: terminal,
    cwd: prepared.workspace,
    resumeThreadId: prepared.sessionId,
    cols: 160,
    rows: 50,
  })
  let lastScreen = ''
  headless.on('screen', screen => {
    lastScreen = screen.plain
  })
  try {
    await headless.start()
    await waitForCodexReady(headless, options.timeoutMs, diagnostics)
    const response = committedResponse(headless, marker, options.timeoutMs, () => lastScreen)
    await submitCodexPrompt(headless, prompt, marker, diagnostics)
    return await response
  } finally {
    try { terminal.kill() } catch { /* PTY may already have exited. */ }
    await headless.stop()
  }
}

async function runClaude(
  prepared: PreparedProjection,
  prompt: string,
  marker: string,
  options: ProbeOptions,
  diagnostics: string[],
): Promise<string> {
  const terminal = pty.spawn(options.claudeBinary, [
    '--resume',
    prepared.sessionId,
    '--safe-mode',
    '--permission-mode',
    'dontAsk',
  ], terminalOptions(prepared.workspace))
  const headless = new ClaudeCodeHeadless({
    pty: terminal,
    cwd: prepared.workspace,
    resumeSessionId: prepared.sessionId,
    cols: 160,
    rows: 50,
  })
  let lastScreen = ''
  headless.on('screen', screen => {
    lastScreen = screen.plain
  })
  try {
    await headless.start()
    await waitForClaudeReady(headless, options.timeoutMs, diagnostics)
    const response = committedResponse(headless, marker, options.timeoutMs, () => lastScreen)
    await submitClaudePrompt(headless, prompt, marker, diagnostics)
    return await response
  } finally {
    try { terminal.kill() } catch { /* PTY may already have exited. */ }
    await headless.stop()
  }
}

async function submitCodexPrompt(
  headless: CodexHeadless,
  prompt: string,
  marker: string,
  diagnostics: string[],
): Promise<void> {
  headless.write(prompt)
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (headless.getScreen().includes(marker)) {
      // WHY Enter is a separate PTY write: both provider TUIs update composer
      // state asynchronously. `text + "\r"` in one chunk can deliver Enter
      // before the framework has committed the text, leaving a fully-rendered
      // draft that never submitted. Waiting for provider-owned screen state
      // turns this from a timing guess into an observable handoff.
      diagnostics.push('Codex composer confirmed draft before Enter')
      headless.write('\r')
      return
    }
    await delay(25)
  }
  throw new Error(`Codex did not render the staged prompt. screen=${JSON.stringify(headless.getScreen().slice(-2_000))}`)
}

async function submitClaudePrompt(
  headless: ClaudeCodeHeadless,
  prompt: string,
  marker: string,
  diagnostics: string[],
): Promise<void> {
  headless.write(prompt)
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (headless.getComposerState() === 'drafted' && headless.getScreen().includes(marker)) {
      diagnostics.push('Claude composer confirmed draft before Enter')
      headless.write('\r')
      return
    }
    await delay(25)
  }
  throw new Error(`Claude did not render the staged prompt. screen=${JSON.stringify(headless.getScreen().slice(-2_000))}`)
}

function committedResponse(
  headless: CodexHeadless | ClaudeCodeHeadless,
  marker: string,
  timeoutMs: number,
  screen: () => string,
): Promise<string> {
  type CommittedEvents = {
    on(event: 'turn_committed', listener: (event: { role: string; text: string }) => void): void
    on(event: 'tail_error', listener: (error: Error) => void): void
    off(event: 'turn_committed', listener: (event: { role: string; text: string }) => void): void
    off(event: 'tail_error', listener: (error: Error) => void): void
  }
  type LifecycleEvents = {
    on(event: 'exit', listener: (event: { exitCode: number; signal?: number }) => void): void
    off(event: 'exit', listener: (event: { exitCode: number; signal?: number }) => void): void
  }
  // WHY narrow structural adapters are used here: both headless packages expose
  // these identical runtime events, but their generic EventEmitter overloads
  // form an uncallable union in TypeScript. The probe depends only on this
  // shared event subset rather than lying that either full provider API is the
  // other provider's type.
  const committed = headless.committed as unknown as CommittedEvents
  const lifecycle = headless as unknown as LifecycleEvents
  return new Promise((resolvePromise, rejectPromise) => {
    let promptCommitted = false
    let lastAssistant = ''
    const timeout = setTimeout(() => {
      cleanup()
      rejectPromise(new Error(
        `Timed out after ${timeoutMs} ms waiting for a committed response. ` +
        `promptCommitted=${promptCommitted}; lastAssistant=${JSON.stringify(lastAssistant.slice(-500))}; ` +
        `screen=${JSON.stringify(screen().slice(-2_000))}`,
      ))
    }, timeoutMs)

    const onTurn = (event: { role: string; text: string }): void => {
      if (event.role === 'user' && event.text.includes(marker)) {
        promptCommitted = true
        return
      }
      if (promptCommitted && event.role === 'assistant' && event.text.trim()) {
        lastAssistant = event.text
        if (event.text.includes(marker)) {
          cleanup()
          resolvePromise(event.text)
        }
      }
    }
    const onExit = (event: { exitCode: number; signal?: number }): void => {
      cleanup()
      rejectPromise(new Error(
        `Provider exited before replying (exitCode=${event.exitCode}, signal=${event.signal ?? 'none'}). ` +
        `screen=${JSON.stringify(screen().slice(-2_000))}`,
      ))
    }
    const onTailError = (error: Error): void => {
      cleanup()
      rejectPromise(new Error(`Transcript tail failed: ${error.message}`))
    }
    const cleanup = (): void => {
      clearTimeout(timeout)
      committed.off('turn_committed', onTurn)
      committed.off('tail_error', onTailError)
      lifecycle.off('exit', onExit)
    }

    committed.on('turn_committed', onTurn)
    committed.on('tail_error', onTailError)
    lifecycle.on('exit', onExit)
  })
}

async function waitForCodexReady(
  headless: CodexHeadless,
  timeoutMs: number,
  diagnostics: string[],
): Promise<void> {
  const deadline = Date.now() + Math.min(timeoutMs, 30_000)
  let acceptedTrust = false
  let skippedUpdate = false
  while (Date.now() < deadline) {
    const screen = headless.getScreen()
    if (
      screen.includes('Update available!') &&
      screen.includes('Update now') &&
      screen.includes('Skip')
    ) {
      if (!skippedUpdate) {
        // WHY choose the one-run Skip option instead of auto-updating or
        // persisting "skip until next version": a diagnostic harness must test
        // the installed binary without changing either the binary or the user's
        // long-lived update preference as an unrelated side effect.
        skippedUpdate = true
        diagnostics.push('skipped Codex update prompt for this probe')
        headless.write('\x1b[B\r')
        await delay(100)
      }
    } else if (screen.includes('Do you trust the contents of this directory')) {
      if (!acceptedTrust) {
        // The cwd is a newly-created empty probe directory. Auto-accepting trust
        // here cannot bless the source repository or any existing user folder.
        acceptedTrust = true
        diagnostics.push('accepted throwaway Codex workspace trust dialog')
        headless.write('\r')
      }
    } else if (
      isCodexReadyForPromptScreen(screen) &&
      !/update (?:available|codex)|updating codex/i.test(screen) &&
      !headless.isWorking()
    ) {
      return
    }
    await delay(50)
  }
  throw new Error(`Codex composer never became ready. screen=${JSON.stringify(headless.getScreen().slice(-2_000))}`)
}

async function waitForClaudeReady(
  headless: ClaudeCodeHeadless,
  timeoutMs: number,
  diagnostics: string[],
): Promise<void> {
  const deadline = Date.now() + Math.min(timeoutMs, 30_000)
  let acceptedTrust = false
  let resolvedResumePrompt = false
  while (Date.now() < deadline) {
    const trust = headless.getTrustDialogState()
    if (trust.visible && !acceptedTrust) {
      acceptedTrust = true
      diagnostics.push('accepted throwaway Claude workspace trust dialog')
      headless.write('\r')
      await delay(100)
      continue
    }
    const resume = headless.getResumePromptState()
    if (resume.visible && !resolvedResumePrompt) {
      resolvedResumePrompt = true
      diagnostics.push('selected full Claude history at large-session resume prompt')
      // WHY full history, not the recommended summary: this harness exists to
      // prove that the translated transcript itself is operational. Letting
      // Claude replace it with a fresh summary would test the summary instead.
      if (resume.selectedIndex === 1) headless.write('\r')
      else headless.write('\x1b[B\r')
      await delay(100)
      continue
    }
    if (headless.getComposerState() === 'empty' && !headless.isWorking()) return
    await delay(50)
  }
  throw new Error(`Claude composer never became ready. screen=${JSON.stringify(headless.getScreen().slice(-2_000))}`)
}

async function loadSource(
  input: string,
  requested: Provider | 'auto',
): Promise<{ provider: Provider; conversation: ConversationDocument }> {
  const document = decodeJsonl(await readFile(input, 'utf8'))
  const codex = classifyCodexDocument(document)
  const claude = classifyClaudeDocument(document)
  const codexScore = codex.records.filter(record => record.family !== 'opaque').length
  const claudeScore = claude.records.filter(record => record.family !== 'opaque').length
  const provider = requested === 'auto'
    ? inferProvider(input, codexScore, claudeScore)
    : requested
  const conversation = provider === 'codex'
    ? decodeCodexConversation(codex.records)
    : decodeClaudeConversation(claude.records)
  if (!conversation.entries.some(entry => entry.kind !== 'opaque')) {
    throw new Error(`${input} produced no projectable ${provider} conversation entries.`)
  }
  return { provider, conversation }
}

function inferProvider(input: string, codexScore: number, claudeScore: number): Provider {
  if (codexScore > claudeScore) return 'codex'
  if (claudeScore > codexScore) return 'claude'
  throw new Error(
    `Could not infer provider for ${input}: Codex and Claude recognition scores both equal ${codexScore}. ` +
    'Pass --source codex or --source claude.',
  )
}

function selectedTargets(selection: TargetSelection, source: Provider): Provider[] {
  if (selection === 'both') return ['codex', 'claude']
  if (selection === 'opposite') return [source === 'codex' ? 'claude' : 'codex']
  return [selection]
}

function summarizeReport(
  report: NativeResumeProjectionResult['report'],
): NonNullable<ProbeResult['projectionReport']> {
  // WHY corpus output carries aggregate loss counts instead of every per-line
  // change: a single long rollout can contain thousands of entries. Echoing the
  // full report made one probe result hundreds of kilobytes and hid the actual
  // runtime failure in truncation. The detailed report remains reproducible
  // from the input and projector; the batch ledger needs only the profile and
  // preservation/loss totals needed to triage which cases deserve inspection.
  return {
    profile: report.profile,
    sourceProvider: report.sourceProvider,
    targetProvider: report.targetProvider,
    counts: report.counts,
  }
}

function parseOptions(args: string[]): ProbeOptions {
  const options: ProbeOptions = {
    inputs: [],
    source: 'auto',
    target: 'opposite',
    prompt: DEFAULT_PROMPT,
    timeoutMs: 180_000,
    maxFiles: null,
    keep: false,
    codexBinary: process.env.ATP_CODEX_BIN ?? 'codex',
    claudeBinary: process.env.ATP_CLAUDE_BIN ?? 'claude',
    codexModel: process.env.ATP_CODEX_MODEL ?? null,
    claudeModel: process.env.ATP_CLAUDE_MODEL ?? process.env.AGENT_CODE_PRIMARY_MODEL ?? 'claude-opus-4-7',
    codexContextCharacters: null,
    // Claude's one-million-token models can accept substantially more history
    // than Codex, but a character bound still prevents pathological 40-80 MB
    // local transcripts from becoming guaranteed API failures.
    claudeContextCharacters: 2_000_000,
    oversizeMode: 'compact',
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    const value = (): string => {
      const next = args[index + 1]
      if (!next) throw new Error(`${arg} requires a value.`)
      index += 1
      return next
    }
    if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else if (arg === '--input' || arg === '-i') options.inputs.push(value())
    else if (arg === '--source') options.source = providerOrAuto(value())
    else if (arg === '--target') options.target = targetSelection(value())
    else if (arg === '--prompt') options.prompt = value()
    else if (arg === '--timeout-ms') options.timeoutMs = positiveInteger(arg, value())
    else if (arg === '--max-files') options.maxFiles = positiveInteger(arg, value())
    else if (arg === '--codex-bin') options.codexBinary = value()
    else if (arg === '--claude-bin') options.claudeBinary = value()
    else if (arg === '--codex-model') options.codexModel = value()
    else if (arg === '--claude-model') options.claudeModel = value()
    else if (arg === '--codex-context-chars') options.codexContextCharacters = positiveInteger(arg, value())
    else if (arg === '--claude-context-chars') options.claudeContextCharacters = positiveInteger(arg, value())
    else if (arg === '--oversize-mode') options.oversizeMode = oversizeMode(value())
    else if (arg === '--keep') options.keep = true
    else if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}.`)
    else options.inputs.push(arg)
  }
  return options
}

async function expandInputs(inputs: string[]): Promise<string[]> {
  const files: string[] = []
  for (const input of inputs) {
    const path = resolve(input)
    const info = await stat(path)
    if (info.isFile()) files.push(path)
    else if (info.isDirectory()) await collectJsonl(path, files)
    else throw new Error(`${path} is neither a regular file nor a directory.`)
  }
  return [...new Set(files)].sort()
}

async function collectJsonl(directory: string, output: string[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await collectJsonl(path, output)
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) output.push(path)
  }
}

async function configuredCodexTargetProfile(options: ProbeOptions) {
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex')
  const configPath = join(codexHome, 'config.toml')
  const cachePath = join(codexHome, 'models_cache.json')
  const [config, cache] = await Promise.all([
    readFile(configPath, 'utf8').catch(() => ''),
    readFile(cachePath, 'utf8')
      .then(value => JSON.parse(value) as unknown)
      .catch(() => null),
  ])
  return resolveCodexTargetProfileFromSources(config, cache, {
    ...(options.codexModel ? { model: options.codexModel } : {}),
  })
}

async function configuredCodexContextCharacters(options: ProbeOptions): Promise<number> {
  return (await configuredCodexTargetProfile(options)).budgetCharacters
}

function portableSummaryPrompt(): string {
  return [
    'Read only. Do not use tools or modify files.',
    'Write a detailed portable handoff summary of the conversation so another coding agent can continue the work.',
    'Include completed work, decisions, files changed, validation, unresolved failures, and exact next steps.',
    'Return only the handoff summary.',
  ].join(' ')
}

function isCodexReadyForPromptScreen(screen: string): boolean {
  // WHY the standalone parser probe keeps this narrow predicate locally: the
  // package must run from its own checkout. Importing Agent Code's renderer or
  // provider runtime inverted the dependency and made the published package's
  // flagship diagnostic impossible to type-check or execute independently.
  if (!screen) return false
  if (screen.includes('Do you trust the contents of this directory')) return false
  if (screen.includes('Yes, continue') && screen.includes('No, quit')) return false
  if (screen.includes('Working (')) return false
  if (screen.includes('Allow command') || screen.includes('allow command')) return false
  if (screen.includes('Approve') && screen.includes('Deny')) return false
  if (screen.includes("don't ask again")) return false
  if (!/(^|\n)›\s/.test(screen)) return false
  return screen.includes(' · ')
}

function binaryVersion(binary: string, strip?: RegExp): string {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`${binary} --version failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout.trim().replace(strip ?? /\s.*$/, '')
}

function terminalOptions(cwd: string): pty.IPtyForkOptions {
  return {
    name: 'xterm-256color',
    cols: 160,
    rows: 50,
    cwd,
    env: process.env as Record<string, string>,
  }
}

async function writeProjection(
  path: string,
  projection: NativeResumeProjectionResult,
): Promise<void> {
  await writeFile(path, `${projection.values.map(value => JSON.stringify(value)).join('\n')}\n`, 'utf8')
}

async function removeCodexRolloutsForWorkspace(
  directory: string,
  workspace: string,
  sessionId: string,
): Promise<void> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      await removeCodexRolloutsForWorkspace(path, workspace, sessionId)
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
    try {
      const firstLine = (await readFile(path, 'utf8')).split('\n', 1)[0]
      if (!firstLine) continue
      const value = JSON.parse(firstLine) as {
        type?: string
        payload?: { id?: string; cwd?: string }
      }
      if (
        value.type === 'session_meta' &&
        (value.payload?.id === sessionId || value.payload?.cwd === workspace)
      ) {
        await rm(path, { force: true })
      }
    } catch {
      // A concurrently-writing unrelated rollout can be temporarily incomplete.
      // Fail closed: cleanup must never delete a file it cannot positively own.
    }
  }
}

function sanitizeClaudePath(value: string): string {
  return value.normalize('NFC').replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200)
}

function providerOrAuto(value: string): Provider | 'auto' {
  if (value === 'auto' || value === 'codex' || value === 'claude') return value
  throw new Error(`--source must be auto, codex, or claude; received ${value}.`)
}

function targetSelection(value: string): TargetSelection {
  if (value === 'opposite' || value === 'both' || value === 'codex' || value === 'claude') return value
  throw new Error(`--target must be opposite, both, codex, or claude; received ${value}.`)
}

function oversizeMode(value: string): OversizeMode {
  if (value === 'compact' || value === 'fail' || value === 'truncate') return value
  throw new Error(`--oversize-mode must be compact, fail, or truncate; received ${value}.`)
}

function positiveInteger(flag: string, value: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer.`)
  return parsed
}

function delay(ms: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

async function removeProbeDirectory(path: string): Promise<void> {
  // node-pty process exit and provider sidecar writes are not atomic with
  // `terminal.kill()`. `rm`'s bounded ENOTEMPTY retry closes that small race
  // without an unbounded cleanup hang during a large corpus run.
  await rm(path, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 100,
  })
}

function printHelp(): void {
  process.stdout.write(`\
Usage: npm run probe:live-resume -- --input <file-or-directory> [options]\n\n\
Runs a real translate -> native resume -> prompt -> committed response probe.\n\n\
Options:\n\
  -i, --input <path>         JSONL file or recursively scanned directory; repeatable\n\
      --source <provider>    auto (default), codex, or claude\n\
      --target <provider>    opposite (default), both, codex, or claude\n\
      --prompt <text>        Read-only diagnostic prompt\n\
      --timeout-ms <ms>      Per-provider response timeout (default: 180000)\n\
      --max-files <count>    Bound a directory/corpus run\n\
      --codex-model <id>     Override top-level $CODEX_HOME/config.toml model\n\
      --claude-model <id>    Projected Claude model metadata\n\
      --codex-context-chars <n>  Override automatic Codex context fitting\n\
      --claude-context-chars <n> Override Claude context fitting (default: 2000000)\n\
      --oversize-mode <mode>  compact (default), fail, or explicit lossy truncate\n\
      --codex-bin <path>     Codex executable (or ATP_CODEX_BIN)\n\
      --claude-bin <path>    Claude executable (or ATP_CLAUDE_BIN)\n\
      --keep                 Keep projected provider files and throwaway workspace\n\
  -h, --help                 Show this help\n\n\
Each case makes a real provider request and prints one JSON result line. Cases run sequentially.\n`)
}

await main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})

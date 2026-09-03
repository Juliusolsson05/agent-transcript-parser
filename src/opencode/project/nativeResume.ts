import type {
  ConversationContent,
  ConversationDocument,
  ConversationEntry,
  ConversationMessage,
  ConversationToolCall,
  ConversationToolResult,
} from '../../conversation/types.js'
import type { EvidenceClaim } from '../../evidence/claim.js'
import { archiveId, isRecord, jsonText } from '../../projection/archiveHelpers.js'
import {
  nativeResumeChange,
  synthesizedNativeResumeChange,
} from '../../projection/nativeResumeHelpers.js'
import type {
  NativeResumeProfile,
  NativeResumeProjectionResult,
  NativeResumeProjector,
  ProjectionBaseOptions,
} from '../../projection/types.js'
import { pairConversationTools } from '../../projection/toolPairs.js'
import { createProjectionReport, type ProjectionChange } from '../../report/types.js'

const TARGET = 'opencode' as const
const SOURCE_COMMIT = '8a6cf2c9aa1aa407129efc4e875a6ce6ab32ef72'
const OPENCODE_NATIVE_EVIDENCE: EvidenceClaim = {
  provenance: 'pinned-upstream-source',
  rule: 'opencode-native-resume-projection',
  profile: { provider: TARGET, sourceCommit: SOURCE_COMMIT },
}

export interface OpencodeNativeResumeOptions extends ProjectionBaseOptions {
  cwd: string
  cliVersion: string
  modelProvider: string
  model: string
  agent?: string
  idFactory?: (seed: string) => string
}

export const opencodeNativeResumeProfile = {
  id: 'opencode-export-import-8a6cf2c9',
  provider: TARGET,
  evidence: { sourceCommit: SOURCE_COMMIT },
} as const satisfies NativeResumeProfile<typeof TARGET>

export const opencodeNativeResumeProjector: NativeResumeProjector<
  typeof TARGET,
  OpencodeNativeResumeOptions,
  typeof opencodeNativeResumeProfile
> = {
  provider: TARGET,
  profile: opencodeNativeResumeProfile,
  projectNativeResume: projectOpencodeNativeResume,
}

/**
 * Project the neutral conversation into the JSON envelope accepted by
 * `opencode import`.
 *
 * WHY the result contains one value: the engine's historical result boundary
 * is an array because Claude/Codex write JSONL records. OpenCode's native
 * storage boundary is one nested export object. Keeping it wrapped preserves
 * the provider-neutral projector interface; the host adapter owns how that
 * native value reaches its CLI.
 */
export function projectOpencodeNativeResume(
  conversation: ConversationDocument,
  options: OpencodeNativeResumeOptions,
): NativeResumeProjectionResult<typeof TARGET, typeof opencodeNativeResumeProfile> {
  const changes: ProjectionChange[] = []
  const messages: Array<Record<string, unknown>> = []
  const makeId = options.idFactory ?? archiveId
  const sessionID = nativeId('ses', options.targetSessionId, makeId)
  const agent = options.agent ?? 'build'
  const model = { providerID: options.modelProvider, modelID: options.model }
  const pairs = pairConversationTools(conversation.entries)
  const pairByCall = new Map(pairs.pairs.map(pair => [pair.callIndex, pair.resultIndex]))
  let nextIdentity = 0
  let lastUserMessageID: string | null = null

  const id = (prefix: 'msg' | 'prt', purpose: string): string =>
    nativeId(prefix, `${sessionID}:${nextIdentity++}:${purpose}`, makeId)
  const time = (entry?: ConversationEntry): number =>
    millis(entry?.timestamp ?? options.now)

  const addUser = (
    parts: Array<Record<string, unknown>>,
    entry: ConversationEntry | undefined,
    purpose: string,
  ): string | null => {
    if (parts.length === 0) return null
    const messageID = id('msg', purpose)
    for (const part of parts) {
      part.id = id('prt', `${purpose}:part`)
      part.sessionID = sessionID
      part.messageID = messageID
    }
    messages.push({
      info: {
        id: messageID,
        sessionID,
        role: 'user',
        time: { created: time(entry) },
        agent,
        model,
      },
      parts,
    })
    lastUserMessageID = messageID
    return messageID
  }

  const ensureParent = (entry: ConversationEntry): string => {
    if (lastUserMessageID) return lastUserMessageID
    const synthetic = addUser(
      [{ type: 'text', text: 'Imported conversation context follows.', synthetic: true }],
      entry,
      'synthetic-parent',
    )!
    const change = synthesizedNativeResumeChange(
      conversation.sourceProvider,
      TARGET,
      'native-resume.parent-user.synthesized',
      'Synthesized the user parent OpenCode requires for leading assistant context.',
    )
    change.evidence.push(OPENCODE_NATIVE_EVIDENCE)
    changes.push(change)
    return synthetic
  }

  const addAssistant = (
    parts: Array<Record<string, unknown>>,
    entry: ConversationEntry,
    purpose: string,
  ): void => {
    if (parts.length === 0) return
    const messageID = id('msg', purpose)
    const created = time(entry)
    for (const part of parts) {
      part.id = id('prt', `${purpose}:part`)
      part.sessionID = sessionID
      part.messageID = messageID
    }
    messages.push({
      info: {
        id: messageID,
        sessionID,
        parentID: ensureParent(entry),
        role: 'assistant',
        mode: agent,
        agent,
        path: { cwd: options.cwd, root: options.cwd },
        cost: 0,
        tokens: {
          total: 0,
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: options.model,
        providerID: options.modelProvider,
        time: { created, completed: created },
        finish: 'stop',
      },
      parts,
    })
  }

  for (const [entryIndex, entry] of conversation.entries.entries()) {
    if (pairs.unmatchedEntryIndexes.has(entryIndex)) {
      changes.push(change(entry, 'dropped', `native-resume.${entry.kind}.unmatched-dropped`,
        `Dropped an unmatched ${entry.kind}; OpenCode stores a tool call and its terminal state as one part.`))
      continue
    }
    if (entry.kind === 'opaque') {
      changes.push(change(entry, 'dropped', 'native-resume.opaque.dropped',
        'Dropped a provider-private record that has no safe OpenCode resume representation.'))
      continue
    }
    if (entry.kind === 'message') {
      const parts = messageParts(entry, changes)
      if (parts.length === 0) {
        changes.push(change(entry, 'dropped', 'native-resume.message.empty-after-filtering',
          'Dropped a message after filtering unsupported content.'))
        continue
      }
      if (entry.role === 'assistant') {
        addAssistant(parts, entry, `assistant:${entryIndex}`)
        changes.push(change(entry, 'preserved', 'native-resume.message.preserved',
          'Projected assistant content into an OpenCode assistant message.'))
      } else {
        if (entry.role === 'developer' || entry.role === 'system') {
          parts.unshift({
            type: 'text',
            text: `[${entry.role === 'system' ? 'System' : 'Developer'} context]`,
            synthetic: true,
          })
          changes.push(change(entry, 'demoted', `native-resume.message.${entry.role}-demoted`,
            `OpenCode export history has no ${entry.role} message role; preserved it as labeled user context.`))
        } else {
          changes.push(change(entry, 'preserved', 'native-resume.message.preserved',
            'Projected user content into an OpenCode user message.'))
        }
        addUser(parts, entry, `user:${entryIndex}`)
      }
      continue
    }
    if (entry.kind === 'reasoning') {
      addAssistant([{
        type: 'reasoning',
        text: entry.text,
        time: { start: time(entry), end: time(entry) },
      }], entry, `reasoning:${entryIndex}`)
      changes.push(change(entry, entry.encrypted ? 'demoted' : 'preserved',
        entry.encrypted
          ? 'native-resume.reasoning.encrypted-demoted'
          : 'native-resume.reasoning.preserved',
        entry.encrypted
          ? 'Dropped provider-local encrypted reasoning while preserving plaintext reasoning.'
          : 'Projected plaintext reasoning into an OpenCode reasoning part.'))
      continue
    }
    if (entry.kind === 'compaction') {
      if (entry.summary.trim().length === 0) {
        changes.push(change(entry, 'dropped', 'native-resume.compaction.empty-dropped',
          'Dropped an empty compaction boundary with no portable summary.'))
        continue
      }
      addUser([{
        type: 'text',
        text: `[Previous conversation summary]\n${entry.summary}`,
        synthetic: true,
      }], entry, `compaction:${entryIndex}`)
      changes.push(change(entry, 'demoted', 'native-resume.compaction.summary-demoted',
        'Projected a portable compaction summary as labeled user context instead of fabricating OpenCode compaction state.'))
      continue
    }
    if (entry.kind === 'tool-result') continue

    const resultIndex = pairByCall.get(entryIndex)
    const result = resultIndex === undefined
      ? null
      : conversation.entries[resultIndex]
    if (!result || result.kind !== 'tool-result') continue
    addAssistant([
      toolPart(entry, result, time(entry)),
    ], entry, `tool:${entryIndex}`)
    changes.push(change(entry, 'preserved', 'native-resume.tool-call.preserved',
      'Projected the matched tool cycle into one OpenCode tool part.'))
    changes.push(change(result, 'preserved', 'native-resume.tool-result.preserved',
      'Projected the matched tool result as the terminal state of its OpenCode tool part.'))
  }

  const created = millis(options.now)
  const exportData = {
    info: {
      id: sessionID,
      slug: 'agent-code-import',
      // OpenCode import deliberately retargets these three fields to the CLI's
      // current project. They still must satisfy the decoded Session schema
      // before that replacement, so emit honest placeholders from host input.
      projectID: 'agent-code-import',
      directory: options.cwd,
      path: '',
      title: `Imported ${conversation.sourceProvider} session`,
      agent,
      model: { id: options.model, providerID: options.modelProvider },
      version: options.cliVersion,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created, updated: created },
    },
    messages,
  }
  const sessionChange = synthesizedNativeResumeChange(
    conversation.sourceProvider,
    TARGET,
    'native-resume.session.synthesized',
    'Synthesized OpenCode session metadata and retargetable import identity.',
  )
  sessionChange.evidence.push(OPENCODE_NATIVE_EVIDENCE)
  changes.unshift(sessionChange)

  return {
    profile: 'native-resume',
    targetProvider: TARGET,
    providerProfile: opencodeNativeResumeProfile,
    values: [exportData],
    report: createProjectionReport('native-resume', conversation.sourceProvider, TARGET, changes),
  }
}

function messageParts(
  entry: ConversationMessage,
  changes: ProjectionChange[],
): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = []
  for (const content of entry.content) {
    if (content.kind === 'text') {
      parts.push({ type: 'text', text: content.text })
      continue
    }
    if (entry.role === 'user' && (content.kind === 'image' || content.kind === 'document')) {
      const file = filePart(content)
      if (file) {
        parts.push(file)
        continue
      }
    }
    changes.push(change(entry, 'dropped', `native-resume.content.${content.kind}-dropped`,
      `Dropped ${content.kind} content that could not be represented safely in OpenCode history.`))
  }
  return parts
}

function filePart(content: Extract<ConversationContent, { kind: 'image' | 'document' }>): Record<string, unknown> | null {
  if (!isRecord(content.value)) return null
  const nativeUrl = typeof content.value.url === 'string' ? content.value.url : null
  const source = isRecord(content.value.source) ? content.value.source : null
  const mediaType = (
    typeof content.value.mime === 'string' ? content.value.mime :
      typeof source?.media_type === 'string' ? source.media_type :
        content.kind === 'image' ? 'image/png' : 'application/octet-stream'
  )
  const url = nativeUrl ?? (
    source?.type === 'base64' && typeof source.data === 'string'
      ? `data:${mediaType};base64,${source.data}`
      : null
  )
  if (!url) return null
  return {
    type: 'file',
    mime: mediaType,
    url,
    ...(typeof content.value.filename === 'string'
      ? { filename: content.value.filename }
      : {}),
  }
}

function toolPart(
  call: ConversationToolCall,
  result: ConversationToolResult,
  timestamp: number,
): Record<string, unknown> {
  const input = isRecord(call.input) ? call.input : { value: call.input }
  const output = jsonText(result.output)
  return {
    type: 'tool',
    callID: call.callId,
    tool: call.name,
    state: result.isError
      ? {
          status: 'error',
          input,
          error: output,
          time: { start: timestamp, end: timestamp },
        }
      : {
          status: 'completed',
          input,
          output,
          title: call.name,
          metadata: {},
          time: { start: timestamp, end: timestamp },
        },
  }
}

function change(
  entry: ConversationEntry,
  kind: ProjectionChange['kind'],
  code: string,
  message: string,
): ProjectionChange {
  const result = nativeResumeChange(entry, TARGET, kind, code, message)
  result.evidence.push(OPENCODE_NATIVE_EVIDENCE)
  return result
}

function nativeId(
  prefix: 'ses' | 'msg' | 'prt',
  seed: string,
  makeId: (seed: string) => string,
): string {
  const generated = makeId(seed)
  if (generated.startsWith(`${prefix}_`)) return generated
  return `${prefix}_${generated.replace(/[^A-Za-z0-9]/g, '')}`
}

function millis(timestamp: string): number {
  const parsed = Date.parse(timestamp)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

import type {
  ConversationContent,
  ConversationDocument,
  ConversationEntry,
  ConversationMessage,
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

const TARGET = 'codex' as const
const SOURCE_COMMIT = '8035cb03f1a5061d0342cb8fa3a10a18068ca683'
const SUMMARY_PREFIX =
  'Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:'
const CODEX_NATIVE_EVIDENCE: EvidenceClaim = {
  provenance: 'pinned-upstream-source',
  rule: 'codex-native-resume-projection',
  profile: { provider: TARGET, sourceCommit: SOURCE_COMMIT },
}

export interface CodexNativeResumeOptions extends ProjectionBaseOptions {
  cwd: string
  cliVersion: string
  modelProvider: string
  model: string
  currentDate?: string
  approvalPolicy?: unknown
  sandboxPolicy?: Record<string, unknown>
  idFactory?: (seed: string) => string
}

export const codexNativeResumeProfile = {
  id: 'codex-rollout-source-8035cb03',
  provider: TARGET,
  evidence: { sourceCommit: SOURCE_COMMIT },
} as const satisfies NativeResumeProfile<typeof TARGET>

export const codexNativeResumeProjector: NativeResumeProjector<
  typeof TARGET,
  CodexNativeResumeOptions,
  typeof codexNativeResumeProfile
> = {
  provider: TARGET,
  profile: codexNativeResumeProfile,
  projectNativeResume: projectCodexNativeResume,
}

export function projectCodexNativeResume(
  conversation: ConversationDocument,
  options: CodexNativeResumeOptions,
): NativeResumeProjectionResult<typeof TARGET, typeof codexNativeResumeProfile> {
  const values: Record<string, unknown>[] = [sessionMeta(options)]
  const sessionMetaChange = synthesizedNativeResumeChange(
    conversation.sourceProvider,
    TARGET,
    'native-resume.session-meta.synthesized',
    'Synthesized the required Codex discovery metadata.',
  )
  sessionMetaChange.evidence.push(CODEX_NATIVE_EVIDENCE)
  const changes: ProjectionChange[] = [sessionMetaChange]
  const makeId = options.idFactory ?? archiveId
  let turnIndex = 0
  let openTurn: { id: string; lastAgentMessage: string } | null = null
  const toolPairing = pairConversationTools(conversation.entries)

  const closeTurn = (timestamp: string): void => {
    if (!openTurn) return
    values.push({
      timestamp,
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: openTurn.id,
        last_agent_message: openTurn.lastAgentMessage,
      },
    })
    openTurn = null
  }

  for (const [entryIndex, entry] of conversation.entries.entries()) {
    const timestamp = entry.timestamp ?? options.now
    if (toolPairing.unmatchedEntryIndexes.has(entryIndex)) {
      changes.push(codexChange(
        entry,
        'dropped',
        `native-resume.${entry.kind}.unmatched-dropped`,
        `Dropped an unmatched ${entry.kind} so Codex does not repair the history differently on load.`,
      ))
      continue
    }
    if (entry.kind === 'opaque') {
      changes.push(codexChange(
        entry,
        'dropped',
        'native-resume.opaque.dropped',
        'Dropped an archive-only source record from the native Codex rollout.',
      ))
      continue
    }
    if (entry.kind === 'compaction') {
      closeTurn(timestamp)
      values.push({
        timestamp,
        type: 'compacted',
        payload: {
          message: `${SUMMARY_PREFIX}\n${entry.summary}`,
          replacement_history: [{
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: `${SUMMARY_PREFIX}\n${entry.summary}` }],
          }],
        },
      })
      changes.push(preserved(entry, 'compaction'))
      continue
    }
    if (entry.kind === 'message') {
      const content = codexNativeContent(entry, changes)
      if (content.length === 0) {
        changes.push(codexChange(
          entry,
          'dropped',
          'native-resume.message.empty-after-filtering',
          'Dropped a message after removing content Codex cannot resume natively.',
        ))
        continue
      }
      if (entry.role === 'user') {
        closeTurn(timestamp)
        const turnId = makeId(`${options.targetSessionId}:turn:${turnIndex}`)
        turnIndex += 1
        openTurn = { id: turnId, lastAgentMessage: '' }
        values.push(
          {
            timestamp,
            type: 'event_msg',
            payload: { type: 'task_started', turn_id: turnId },
          },
          {
            timestamp,
            type: 'turn_context',
            payload: {
              turn_id: turnId,
              cwd: options.cwd,
              current_date: options.currentDate ?? timestamp.slice(0, 10),
              approval_policy: options.approvalPolicy ?? 'on-request',
              sandbox_policy: options.sandboxPolicy ?? { type: 'workspace-write' },
              model: options.model,
              summary: 'auto',
            },
          },
          {
            timestamp,
            type: 'event_msg',
            payload: { type: 'user_message', message: userEventText(entry, content) },
          },
        )
        const framingChange = synthesizedNativeResumeChange(
          conversation.sourceProvider,
          TARGET,
          'native-resume.turn-framing.synthesized',
          'Synthesized Codex turn boundaries required for reliable reconstruction.',
        )
        framingChange.evidence.push(CODEX_NATIVE_EVIDENCE)
        changes.push(framingChange)
      }
      if (entry.role === 'assistant') {
        const text = entry.content
          .filter((item): item is Extract<ConversationContent, { kind: 'text' }> => item.kind === 'text')
          .map(item => item.text)
          .join('\n\n')
        values.push({
          timestamp,
          type: 'event_msg',
          payload: { type: 'agent_message', message: text, phase: 'final_answer' },
        })
        if (openTurn) openTurn.lastAgentMessage = text
      }
      values.push({
        timestamp,
        type: 'response_item',
        payload: {
          type: 'message',
          role: entry.role,
          content,
          ...(entry.role === 'assistant' ? { phase: 'final_answer' } : {}),
        },
      })
      changes.push(preserved(entry, 'message'))
      continue
    }
    values.push(projectNonMessage(entry, timestamp))
    changes.push(preserved(entry, entry.kind))
    if (entry.kind === 'tool-result' && entry.isError !== null) {
      changes.push(codexChange(
        entry,
        'demoted',
        'native-resume.tool-result.error-status-demoted',
        'Codex function-call output has no native error-status field; preserved the output body without that annotation.',
      ))
    }
  }

  closeTurn(conversation.entries.at(-1)?.timestamp ?? options.now)
  return {
    profile: 'native-resume',
    targetProvider: TARGET,
    providerProfile: codexNativeResumeProfile,
    values,
    report: createProjectionReport('native-resume', conversation.sourceProvider, TARGET, changes),
  }
}

function projectNonMessage(entry: Exclude<ConversationEntry, { kind: 'message' | 'opaque' | 'compaction' }>, timestamp: string): Record<string, unknown> {
  if (entry.kind === 'tool-call') {
    return {
      timestamp,
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: entry.name,
        arguments: jsonText(entry.input),
        call_id: entry.callId,
      },
    }
  }
  if (entry.kind === 'tool-result') {
    return {
      timestamp,
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: entry.callId, output: jsonText(entry.output) },
    }
  }
  return {
    timestamp,
    type: 'response_item',
    payload: {
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: entry.text }],
      ...(entry.encrypted === null ? {} : { encrypted_content: entry.encrypted }),
    },
  }
}

function codexNativeContent(
  entry: ConversationMessage,
  changes: ProjectionChange[],
): Record<string, unknown>[] {
  const content: Record<string, unknown>[] = []
  for (const item of entry.content) {
    if (item.kind === 'text') {
      content.push({ type: entry.role === 'assistant' ? 'output_text' : 'input_text', text: item.text })
      continue
    }
    const image = entry.role === 'user' ? codexImage(item) : null
    if (image) {
      content.push(image)
      continue
    }
    changes.push(codexChange(
      entry,
      'dropped',
      `native-resume.content.${item.kind}.dropped`,
      `Dropped ${item.kind} content without a valid native Codex representation.`,
    ))
  }
  return content
}

function codexImage(content: ConversationContent): Record<string, unknown> | null {
  if (content.kind !== 'image' || !isRecord(content.value)) return null
  if (content.value.type === 'input_image' && typeof content.value.image_url === 'string') {
    return { type: 'input_image', image_url: content.value.image_url }
  }
  const source = isRecord(content.value.source) ? content.value.source : null
  if (
    source?.type === 'base64' &&
    typeof source.media_type === 'string' &&
    typeof source.data === 'string'
  ) {
    return { type: 'input_image', image_url: `data:${source.media_type};base64,${source.data}` }
  }
  return null
}

function userEventText(entry: ConversationMessage, content: Record<string, unknown>[]): string {
  const text = entry.content
    .filter((item): item is Extract<ConversationContent, { kind: 'text' }> => item.kind === 'text')
    .map(item => item.text)
    .join('\n\n')
  return text || (content.some(item => item.type === 'input_image') ? '[User provided an image]' : '')
}

function sessionMeta(options: CodexNativeResumeOptions): Record<string, unknown> {
  return {
    timestamp: options.now,
    type: 'session_meta',
    payload: {
      id: options.targetSessionId,
      timestamp: options.now,
      cwd: options.cwd,
      originator: 'agent-transcript-parser-v2',
      cli_version: options.cliVersion,
      source: 'cli',
      model_provider: options.modelProvider,
      git: {},
    },
  }
}

function preserved(entry: ConversationEntry, kind: string): ProjectionChange {
  return codexChange(
    entry,
    'preserved',
    `native-resume.${kind}.preserved`,
    `Projected the neutral ${kind} into the pinned Codex resume profile.`,
  )
}

function codexChange(
  entry: ConversationEntry,
  kind: ProjectionChange['kind'],
  code: string,
  message: string,
): ProjectionChange {
  const change = nativeResumeChange(entry, TARGET, kind, code, message)
  change.evidence.push(CODEX_NATIVE_EVIDENCE)
  return change
}

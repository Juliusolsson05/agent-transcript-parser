import type {
  ConversationContent,
  ConversationDocument,
  ConversationEntry,
  ConversationMessage,
} from '../../conversation/types.js'
import type { EvidenceClaim } from '../../evidence/claim.js'
import { archiveProvenance } from '../../projection/archiveProvenance.js'
import {
  archiveChange,
  cloneRawRecord,
  isRecord,
  jsonText,
  sameProviderSourceRecords,
  synthesizedArchiveChange,
} from '../../projection/archiveHelpers.js'
import type {
  ArchiveProjectionOptions,
  ArchiveProjectionResult,
  ArchiveProjector,
} from '../../projection/types.js'
import { createProjectionReport, type ProjectionChange } from '../../report/types.js'

const TARGET = 'codex' as const
const CODEX_ARCHIVE_EVIDENCE: EvidenceClaim = {
  provenance: 'human-reviewed-semantics',
  rule: 'codex-archive-projection',
  profile: { provider: TARGET },
}

export const codexArchiveProjector: ArchiveProjector<typeof TARGET> = {
  provider: TARGET,
  projectArchive: projectCodexArchive,
}

export function projectCodexArchive(
  conversation: ConversationDocument,
  options: ArchiveProjectionOptions,
): ArchiveProjectionResult<typeof TARGET> {
  const sameProvider = sameProviderSourceRecords(conversation, TARGET)
  if (sameProvider) return preserveCodexArchive(conversation, sameProvider, options)

  const values: Record<string, unknown>[] = [sessionMeta(options)]
  const metaChange = synthesizedArchiveChange(
    conversation.sourceProvider,
    TARGET,
    'archive.session-meta.synthesized',
    'Synthesized the target Codex archive identity record.',
  )
  metaChange.evidence.push(CODEX_ARCHIVE_EVIDENCE)
  const changes: ProjectionChange[] = [metaChange]

  for (const entry of conversation.entries) {
    values.push(projectEntry(entry, options))
    const isOpaque = entry.kind === 'opaque'
    const isDemotedMessage = entry.kind === 'message' && entry.content.some(isNonNativeArchiveContent)
    changes.push(archiveChange(
      entry,
      TARGET,
      isOpaque ? 'opaque' : isDemotedMessage ? 'demoted' : 'preserved',
      isOpaque
        ? 'archive.opaque.provenance-preserved'
        : isDemotedMessage
          ? 'archive.message.non-native-content-demoted'
          : `archive.${entry.kind}.semantic-preserved`,
      isOpaque
        ? 'Preserved an unknown source record in bounded archive provenance.'
        : isDemotedMessage
          ? 'Preserved non-native message content in an archive-only content block.'
          : `Preserved the neutral ${entry.kind} semantics in a Codex archive record.`,
      [CODEX_ARCHIVE_EVIDENCE],
    ))
  }

  return archiveResult(conversation, values, changes)
}

function preserveCodexArchive(
  conversation: ConversationDocument,
  entries: ConversationEntry[],
  options: ArchiveProjectionOptions,
): ArchiveProjectionResult<typeof TARGET> {
  const values: Record<string, unknown>[] = []
  const changes: ProjectionChange[] = []
  let foundSessionMeta = false

  for (const entry of entries) {
    const raw = cloneRawRecord(entry)
    if (raw.type === 'session_meta' && isRecord(raw.payload)) {
      foundSessionMeta = true
      const previous = raw.payload.id
      raw.payload = { ...raw.payload, id: options.targetSessionId }
      if (previous !== options.targetSessionId) {
        changes.push(archiveChange(
          entry,
          TARGET,
          'retargeted',
          'archive.same-provider.session-retargeted',
            'Retargeted the Codex session metadata while retaining its remaining wire fields.',
            [CODEX_ARCHIVE_EVIDENCE],
        ))
      }
    }
    values.push(raw)
    changes.push(archiveChange(
      entry,
      TARGET,
      'preserved',
      'archive.same-provider.raw-preserved',
      'Preserved the original Codex record rather than reconstructing it from neutral semantics.',
      [CODEX_ARCHIVE_EVIDENCE],
    ))
  }

  if (!foundSessionMeta) {
    values.unshift(sessionMeta(options))
    const metaChange = synthesizedArchiveChange(
      conversation.sourceProvider,
      TARGET,
      'archive.session-meta.synthesized',
      'Synthesized missing Codex session metadata for the archive.',
    )
    metaChange.evidence.push(CODEX_ARCHIVE_EVIDENCE)
    changes.unshift(metaChange)
  }
  return archiveResult(conversation, values, changes)
}

function projectEntry(
  entry: ConversationEntry,
  options: ArchiveProjectionOptions,
): Record<string, unknown> {
  const timestamp = entry.timestamp ?? options.now
  const atpArchive = archiveProvenance(entry, options.maxEmbeddedSourceBytes)
  if (entry.kind === 'message') {
    return {
      timestamp,
      type: 'response_item',
      payload: {
        type: 'message',
        role: entry.role,
        content: entry.content.map(content => codexContent(entry, content)),
      },
      atp_archive: atpArchive,
    }
  }
  if (entry.kind === 'tool-call') {
    return {
      timestamp,
      type: 'response_item',
      payload: {
        type: 'function_call',
        call_id: entry.callId,
        name: entry.name,
        arguments: jsonText(entry.input),
      },
      atp_archive: atpArchive,
    }
  }
  if (entry.kind === 'tool-result') {
    return {
      timestamp,
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: entry.callId,
        output: jsonText(entry.output),
      },
      atp_archive: atpArchive,
    }
  }
  if (entry.kind === 'reasoning') {
    return {
      timestamp,
      type: 'response_item',
      payload: {
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: entry.text }],
        ...(entry.encrypted === null ? {} : { encrypted_content: entry.encrypted }),
      },
      atp_archive: atpArchive,
    }
  }
  if (entry.kind === 'compaction') {
    return {
      timestamp,
      type: 'compacted',
      payload: { message: entry.summary },
      atp_archive: atpArchive,
    }
  }
  return { timestamp, type: 'atp_archive', payload: atpArchive }
}

function codexContent(
  message: ConversationMessage,
  content: ConversationContent,
): Record<string, unknown> {
  if (content.kind === 'text') {
    return {
      type: message.role === 'assistant' ? 'output_text' : 'input_text',
      text: content.text,
    }
  }
  if (content.kind === 'image' && isRecord(content.value)) return { ...content.value }
  return {
    type: 'atp_opaque_content',
    content_kind: content.kind,
    ...(content.kind === 'opaque' ? { native_type: content.nativeType } : {}),
    value: content.value,
  }
}

function isNonNativeArchiveContent(content: ConversationContent): boolean {
  return content.kind === 'document' || content.kind === 'opaque'
}

function sessionMeta(options: ArchiveProjectionOptions): Record<string, unknown> {
  return {
    timestamp: options.now,
    type: 'session_meta',
    payload: {
      id: options.targetSessionId,
      timestamp: options.now,
      source: 'agent-transcript-parser-archive',
      originator: 'agent-transcript-parser',
    },
  }
}

function archiveResult(
  conversation: ConversationDocument,
  values: Record<string, unknown>[],
  changes: ProjectionChange[],
): ArchiveProjectionResult<typeof TARGET> {
  return {
    profile: 'archive',
    targetProvider: TARGET,
    values,
    report: createProjectionReport('archive', conversation.sourceProvider, TARGET, changes),
  }
}

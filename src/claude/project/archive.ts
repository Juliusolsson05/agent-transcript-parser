import type {
  ConversationContent,
  ConversationDocument,
  ConversationEntry,
} from '../../conversation/types.js'
import type { EvidenceClaim } from '../../evidence/claim.js'
import { archiveProvenance } from '../../projection/archiveProvenance.js'
import {
  archiveChange,
  archiveId,
  cloneRawRecord,
  isRecord,
  sameProviderSourceRecords,
} from '../../projection/archiveHelpers.js'
import type {
  ArchiveProjectionOptions,
  ArchiveProjectionResult,
  ArchiveProjector,
} from '../../projection/types.js'
import { createProjectionReport, type ProjectionChange } from '../../report/types.js'

const TARGET = 'claude' as const
const CLAUDE_ARCHIVE_EVIDENCE: EvidenceClaim = {
  provenance: 'human-reviewed-semantics',
  rule: 'claude-archive-projection',
  profile: { provider: TARGET },
}

export const claudeArchiveProjector: ArchiveProjector<typeof TARGET> = {
  provider: TARGET,
  projectArchive: projectClaudeArchive,
}

export function projectClaudeArchive(
  conversation: ConversationDocument,
  options: ArchiveProjectionOptions,
): ArchiveProjectionResult<typeof TARGET> {
  const sameProvider = sameProviderSourceRecords(conversation, TARGET)
  if (sameProvider) return preserveClaudeArchive(conversation, sameProvider, options)

  const values: Record<string, unknown>[] = []
  const changes: ProjectionChange[] = []
  let parentUuid: string | null = null
  const createId = options.idFactory ?? archiveId

  for (const [index, entry] of conversation.entries.entries()) {
    if (entry.kind === 'opaque' && entry.nativeType === 'session_meta') {
      // WHY Codex discovery metadata is not conversation history: the target
      // projector owns its own session identity. Archiving source session_meta
      // as an opaque Claude record makes one extra carrier accumulate on every
      // alternating Claude↔Codex archive pass.
      changes.push(archiveChange(
        entry,
        TARGET,
        'dropped',
        'archive.source-session-meta.dropped',
        'Dropped source-provider session discovery metadata that the target regenerates.',
        [CLAUDE_ARCHIVE_EVIDENCE],
      ))
      continue
    }
    const uuid = createId(`${options.targetSessionId}:archive:${index}`)
    values.push(projectEntry(entry, options, uuid, parentUuid))
    const isOpaque = entry.kind === 'opaque'
    const isDemotedMessage = entry.kind === 'message' && (
      entry.role === 'developer' ||
      entry.role === 'system' ||
      entry.content.some(content => content.kind === 'opaque')
    )
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
          ? 'Preserved a non-native message as an archive-only Claude record.'
          : `Preserved the neutral ${entry.kind} semantics in a Claude archive record.`,
      [CLAUDE_ARCHIVE_EVIDENCE],
    ))
    parentUuid = uuid
  }

  return archiveResult(conversation, values, changes)
}

function preserveClaudeArchive(
  conversation: ConversationDocument,
  entries: ConversationEntry[],
  options: ArchiveProjectionOptions,
): ArchiveProjectionResult<typeof TARGET> {
  const values: Record<string, unknown>[] = []
  const changes: ProjectionChange[] = []
  for (const entry of entries) {
    const raw = cloneRawRecord(entry)
    const previous = raw.sessionId
    raw.sessionId = options.targetSessionId
    values.push(raw)
    if (previous !== options.targetSessionId) {
      changes.push(archiveChange(
        entry,
        TARGET,
        'retargeted',
        'archive.same-provider.session-retargeted',
        'Retargeted the Claude session id while retaining its remaining wire fields.',
        [CLAUDE_ARCHIVE_EVIDENCE],
      ))
    }
    changes.push(archiveChange(
      entry,
      TARGET,
      'preserved',
      'archive.same-provider.raw-preserved',
      'Preserved the original Claude record rather than reconstructing it from neutral semantics.',
      [CLAUDE_ARCHIVE_EVIDENCE],
    ))
  }
  return archiveResult(conversation, values, changes)
}

function projectEntry(
  entry: ConversationEntry,
  options: ArchiveProjectionOptions,
  uuid: string,
  parentUuid: string | null,
): Record<string, unknown> {
  const base = {
    uuid,
    parentUuid,
    sessionId: options.targetSessionId,
    timestamp: entry.timestamp ?? options.now,
  }
  const atpArchive = archiveProvenance(entry, options.maxEmbeddedSourceBytes)

  if (entry.kind === 'message') {
    if (entry.role === 'developer' || entry.role === 'system') {
      return {
        ...base,
        type: 'atp_archive',
        payload: {
          semantic_kind: 'message',
          role: entry.role,
          content: entry.content,
          provenance: atpArchive,
        },
      }
    }
    return {
      ...base,
      type: entry.role,
      message: {
        role: entry.role,
        content: entry.content.map(claudeContent),
      },
      atp_archive: atpArchive,
    }
  }
  if (entry.kind === 'tool-call') {
    return {
      ...base,
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: entry.callId, name: entry.name, input: entry.input }],
      },
      atp_archive: atpArchive,
    }
  }
  if (entry.kind === 'tool-result') {
    return {
      ...base,
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: entry.callId,
          content: entry.output,
          ...(entry.isError === null ? {} : { is_error: entry.isError }),
        }],
      },
      atp_archive: atpArchive,
    }
  }
  if (entry.kind === 'reasoning') {
    return {
      ...base,
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{
          type: 'thinking',
          thinking: entry.text,
          ...(entry.encrypted === null ? {} : { signature: entry.encrypted }),
        }],
      },
      atp_archive: atpArchive,
    }
  }
  if (entry.kind === 'compaction') {
    return {
      ...base,
      type: 'system',
      subtype: 'compact_boundary',
      content: entry.summary,
      compactMetadata: { message: entry.summary },
      atp_archive: atpArchive,
    }
  }
  return { ...base, type: 'atp_archive', payload: atpArchive }
}

function claudeContent(content: ConversationContent): unknown {
  if (content.kind === 'text') return { type: 'text', text: content.text }
  if ((content.kind === 'image' || content.kind === 'document') && isRecord(content.value)) {
    return { ...content.value }
  }
  return {
    type: 'atp_opaque_content',
    native_type: content.kind === 'opaque' ? content.nativeType : content.kind,
    value: content.value,
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

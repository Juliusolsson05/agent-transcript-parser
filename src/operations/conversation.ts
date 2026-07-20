import type {
  ConversationContent,
  ConversationDocument,
  ConversationMessage,
} from '../conversation/types.js'
import type { PromptAddress } from './promptAddress.js'

export class PromptAddressNotFoundError extends Error {
  constructor(address: PromptAddress) {
    super(`No user prompt exists at ${address.provider} source line ${address.line}.`)
    this.name = 'PromptAddressNotFoundError'
  }
}

export interface RewindConversationResult {
  conversation: ConversationDocument
  anchor: PromptAddress
  draft: ConversationContent[]
  removedEntries: number
}

/**
 * Select the strict semantic prefix before one provider-native prompt address.
 * The address is the same object produced by provider analysis; no filtered UI
 * ordinal is recomputed here. Opaque duplicate event-plane records may remain
 * in the neutral prefix, but native-resume projectors deliberately remove them,
 * so a Codex event_msg immediately before its response_item cannot reinsert the
 * rewound prompt.
 */
export function rewindConversation(
  conversation: ConversationDocument,
  address: PromptAddress,
): RewindConversationResult {
  const anchor = resolveUserPrompt(conversation, address)
  const entries = conversation.entries.filter(entry => entry.source.line < address.line)
  return {
    conversation: { ...conversation, entries },
    anchor: { ...address },
    draft: cloneContent(anchor.content),
    removedEntries: conversation.entries.length - entries.length,
  }
}

export function resolveUserPrompt(
  conversation: ConversationDocument,
  address: PromptAddress,
): ConversationMessage {
  if (conversation.sourceProvider !== address.provider) throw new PromptAddressNotFoundError(address)
  if (
    address.sessionId !== null &&
    conversation.sourceSessionIds.length > 0 &&
    !conversation.sourceSessionIds.includes(address.sessionId)
  ) {
    throw new PromptAddressNotFoundError(address)
  }
  const entry = conversation.entries.find(candidate => (
    candidate.kind === 'message' &&
    candidate.role === 'user' &&
    candidate.source.provider === address.provider &&
    candidate.source.line === address.line &&
    matchesClaudeUuid(candidate, address)
  ))
  if (!entry || entry.kind !== 'message') throw new PromptAddressNotFoundError(address)
  return entry
}

function matchesClaudeUuid(message: ConversationMessage, address: PromptAddress): boolean {
  if (address.provider !== 'claude' || !('uuid' in address)) return true
  const rawUuid = message.source.raw.uuid
  return (typeof rawUuid === 'string' ? rawUuid : null) === address.uuid
}

function cloneContent(content: ConversationContent[]): ConversationContent[] {
  // Conversation content is JSON-domain data. structuredClone retains nulls,
  // arrays, and omitted properties without smuggling provider objects by
  // reference into the host's editable draft state.
  return structuredClone(content)
}

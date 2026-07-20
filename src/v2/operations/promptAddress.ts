export interface PromptAddress {
  provider: string
  line: number
  sessionId: string | null
}

export interface ClaudePromptAddress extends PromptAddress {
  provider: 'claude'
  uuid: string | null
}

export interface CodexPromptAddress extends PromptAddress {
  provider: 'codex'
}

export interface PromptReference<TAddress extends PromptAddress = PromptAddress> {
  address: TAddress
  raw: Record<string, unknown>
}

/**
 * Addresses point at provider-native raw records, not UI ordinals. A renderer is
 * free to hide meta rows or duplicate event planes, but it must pass this object
 * back unchanged. Recomputing an ordinal after filtering is the exact defect
 * that made the v1 Codex picker and rewinder disagree.
 */
export function samePromptAddress(a: PromptAddress, b: PromptAddress): boolean {
  if (a.provider !== b.provider) return false
  if (a.line !== b.line || a.sessionId !== b.sessionId) return false
  // Claude carries an additional native record id. Other providers can use the
  // universal provider/session/line coordinate without editing this function;
  // provider-specific resolvers remain free to add stronger checks later.
  if (a.provider !== 'claude' || b.provider !== 'claude') return true
  return claudeUuid(a) === claudeUuid(b)
}

function claudeUuid(address: PromptAddress): string | null | undefined {
  return 'uuid' in address && (typeof address.uuid === 'string' || address.uuid === null)
    ? address.uuid
    : undefined
}

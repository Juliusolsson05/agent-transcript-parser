export interface ClaudePromptAddress {
  provider: 'claude'
  line: number
  sessionId: string | null
  uuid: string | null
}

export interface CodexPromptAddress {
  provider: 'codex'
  line: number
  sessionId: string | null
}

export type PromptAddress = ClaudePromptAddress | CodexPromptAddress

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
  return a.provider === 'codex' || (b.provider === 'claude' && a.uuid === b.uuid)
}

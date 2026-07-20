// Minimal frozen wire vocabulary for the ghost subsystem.
//
// WHY this is independent from the transcript engine: ghosts represent
// provisional render ownership, while the engine represents durable provider
// history. The former
// uses a Claude-shaped carrier because that is Agent Code's established live
// rendering seam; importing the old converter-wide `types.ts` kept hundreds of
// permissive converter-wide wire types alive merely to describe this one frozen
// record.

export const ATP_KEY = '_atp' as const

export type AtpGhostSidecar = {
  origin: 'ghost'
  turnId: string
  blockIndex: number
  createdAt: number
  updatedAt: number
  supersededBy?: string
  orphanedAt?: number
  context?: Record<string, unknown>
}

export type ClaudeRole = 'user' | 'assistant'
export type ClaudeTextBlock = { type: 'text'; text: string }
export type ClaudeToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
  caller?: { type?: string } & Record<string, unknown>
  codex?: Record<string, unknown>
}
export type ClaudeToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  content: string | Array<{ type: string; text?: string; [key: string]: unknown }>
  is_error?: boolean
  codex?: Record<string, unknown>
}
export type ClaudeThinkingBlock = {
  type: 'thinking'
  thinking: string
  signature?: string
  codex?: Record<string, unknown>
}
export type ClaudeContentBlock =
  | ClaudeTextBlock
  | ClaudeToolUseBlock
  | ClaudeToolResultBlock
  | ClaudeThinkingBlock
  | { type: string; [key: string]: unknown }

export type ClaudeEntry = {
  type: string
  uuid: string
  parentUuid: string | null
  sessionId: string
  timestamp: string
  message?: {
    role: ClaudeRole
    content: string | ClaudeContentBlock[]
  }
  _atp?: unknown
  [key: string]: unknown
}

export type GhostEntry = ClaudeEntry & {
  type: 'user' | 'assistant'
  message: NonNullable<ClaudeEntry['message']>
  _atp: AtpGhostSidecar
}

export function readSidecar(record: unknown): AtpGhostSidecar | null {
  if (!isRecord(record) || !isRecord(record[ATP_KEY])) return null
  const sidecar = record[ATP_KEY]
  if (sidecar.origin !== 'ghost') return null
  if (typeof sidecar.turnId !== 'string' || sidecar.turnId.length === 0) return null
  if (typeof sidecar.blockIndex !== 'number' || !Number.isFinite(sidecar.blockIndex)) return null
  if (typeof sidecar.createdAt !== 'number' || !Number.isFinite(sidecar.createdAt)) return null
  if (typeof sidecar.updatedAt !== 'number' || !Number.isFinite(sidecar.updatedAt)) return null
  return sidecar as AtpGhostSidecar
}

export function isGhost(record: unknown): record is GhostEntry {
  return readSidecar(record) !== null
}

export function ghostSidecar(record: unknown): AtpGhostSidecar | null {
  return readSidecar(record)
}

export function stripSidecar<T extends object>(record: T): T {
  if (!(ATP_KEY in record)) return record
  const clone: Record<string, unknown> = { ...record }
  delete clone[ATP_KEY]
  return clone as T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

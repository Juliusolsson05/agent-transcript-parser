import type { ConversationDocument } from './types.js'

/**
 * One decoder per provider is the inbound half of the linear-growth design.
 * The input remains generic because classification is necessarily provider
 * specific; the output is always the same neutral conversation protocol.
 */
export interface ConversationDecoder<TProvider extends string, TInput> {
  readonly provider: TProvider
  decode(input: readonly TInput[]): ConversationDocument
}

import type { ConversationDocument } from '../conversation/types.js'
import type {
  NativeResumeProfile,
  NativeResumeProjectionResult,
  NativeResumeProjector,
  ProjectionBaseOptions,
} from '../projection/types.js'
import type { PromptAddress } from './promptAddress.js'
import { rewindConversation } from './conversation.js'

export type CloneForNativeResumeResult<
  TProvider extends string,
  TProfile extends NativeResumeProfile<TProvider>,
> = NativeResumeProjectionResult<TProvider, TProfile> & { operation: 'clone' }

export type RewindForNativeResumeResult<
  TProvider extends string,
  TProfile extends NativeResumeProfile<TProvider>,
> = NativeResumeProjectionResult<TProvider, TProfile> & {
  operation: 'rewind'
  anchor: PromptAddress
  draft: ReturnType<typeof rewindConversation>['draft']
  removedEntries: number
}

/**
 * Cloning is a full neutral conversation projected under a fresh caller-owned
 * target identity. The target adapter handles provider identity and repair;
 * this shared operation never needs a provider branch.
 */
export function cloneForNativeResume<
  TProvider extends string,
  TOptions extends ProjectionBaseOptions,
  TProfile extends NativeResumeProfile<TProvider>,
>(
  conversation: ConversationDocument,
  target: NativeResumeProjector<TProvider, TOptions, TProfile>,
  options: TOptions,
): CloneForNativeResumeResult<TProvider, TProfile> {
  return { operation: 'clone', ...target.projectNativeResume(conversation, options) }
}

export function rewindForNativeResume<
  TProvider extends string,
  TOptions extends ProjectionBaseOptions,
  TProfile extends NativeResumeProfile<TProvider>,
>(
  conversation: ConversationDocument,
  address: PromptAddress,
  target: NativeResumeProjector<TProvider, TOptions, TProfile>,
  options: TOptions,
): RewindForNativeResumeResult<TProvider, TProfile> {
  const rewind = rewindConversation(conversation, address)
  return {
    operation: 'rewind',
    anchor: rewind.anchor,
    draft: rewind.draft,
    removedEntries: rewind.removedEntries,
    ...target.projectNativeResume(rewind.conversation, options),
  }
}

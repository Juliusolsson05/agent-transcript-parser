import type { ConversationDecoder } from '../conversation/decoder.js'
import type {
  ArchiveProjectionOptions,
  ArchiveProjectionResult,
  ArchiveProjector,
} from '../projection/types.js'

/**
 * Cross-provider archive translation is deliberately boring composition. The
 * source adapter only knows how to decode into the neutral protocol and the
 * target adapter only knows how to project from it. Keeping this function free
 * of provider names is the executable form of the O(N), rather than O(N²),
 * architecture: adding a provider cannot add another branch here.
 */
export function translateArchive<
  TSourceProvider extends string,
  TSourceInput,
  TTargetProvider extends string,
>(
  source: ConversationDecoder<TSourceProvider, TSourceInput>,
  target: ArchiveProjector<TTargetProvider>,
  input: readonly TSourceInput[],
  options: ArchiveProjectionOptions,
): ArchiveProjectionResult<TTargetProvider> {
  return target.projectArchive(source.decode(input), options)
}

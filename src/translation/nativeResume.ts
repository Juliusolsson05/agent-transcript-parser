import type { ConversationDecoder } from '../conversation/decoder.js'
import type {
  NativeResumeProfile,
  NativeResumeProjectionResult,
  NativeResumeProjector,
  ProjectionBaseOptions,
} from '../projection/types.js'

/**
 * Resume translation uses the same provider-independent composition as archive
 * translation, but its distinct projector type makes it impossible to select
 * an archive writer accidentally. No provider pair is named or special-cased.
 */
export function translateNativeResume<
  TSourceProvider extends string,
  TSourceInput,
  TTargetProvider extends string,
  TOptions extends ProjectionBaseOptions,
  TProfile extends NativeResumeProfile<TTargetProvider>,
>(
  source: ConversationDecoder<TSourceProvider, TSourceInput>,
  target: NativeResumeProjector<TTargetProvider, TOptions, TProfile>,
  input: readonly TSourceInput[],
  options: TOptions,
): NativeResumeProjectionResult<TTargetProvider, TProfile> {
  return target.projectNativeResume(source.decode(input), options)
}

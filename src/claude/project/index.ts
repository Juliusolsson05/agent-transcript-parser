export { claudeArchiveProjector, projectClaudeArchive } from './archive.js'
export {
  claudeNativeResumeProfile,
  claudeNativeResumeProjector,
  projectClaudeNativeResume,
} from './nativeResume.js'
export type { ClaudeNativeResumeOptions } from './nativeResume.js'
// Not Claude-specific despite living here: every provider records an
// attachment as a data URL sooner or later, and this is the one place that
// decides what counts as one.
export { parseBase64DataUrl } from './nativeResume.js'

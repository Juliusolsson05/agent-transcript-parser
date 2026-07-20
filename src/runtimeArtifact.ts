/**
 * Recognize the frozen ghost wire marker without importing the ghost module.
 *
 * Ghosts are provisional renderer ownership records, not conversation history.
 * The transcript engine is intentionally unable to construct or reconcile
 * them, but it
 * must still keep a mixed JSONL input from promoting one into semantic history.
 * Requiring the complete sidecar coordinate mirrors the frozen public guard:
 * a malformed or user-authored `_atp` object stays ordinary opaque evidence
 * instead of silently deleting data merely because it contains one magic word.
 */
export function isGhostRuntimeArtifact(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value._atp)) return false
  const sidecar = value._atp
  return sidecar.origin === 'ghost' &&
    typeof sidecar.turnId === 'string' &&
    sidecar.turnId.length > 0 &&
    typeof sidecar.blockIndex === 'number' &&
    Number.isFinite(sidecar.blockIndex) &&
    typeof sidecar.createdAt === 'number' &&
    Number.isFinite(sidecar.createdAt) &&
    typeof sidecar.updatedAt === 'number' &&
    Number.isFinite(sidecar.updatedAt)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

import { budgetCharactersForContextTokens } from '../../operations/contextBudget.js'

export interface CodexTargetProfile {
  model: string
  modelProvider: string
  contextTokens: number
  effectiveContextPercent: number
  budgetCharacters: number
}

export interface CodexTargetProfileOptions {
  model?: string
}

export function resolveCodexTargetProfileFromSources(
  configToml: string,
  modelsCache: unknown,
  options: CodexTargetProfileOptions = {},
): CodexTargetProfile {
  const activeProfile = topLevelTomlString(configToml, 'profile')
  const configuredModel = options.model ?? (
    activeProfile ? profileTomlString(configToml, activeProfile, 'model') : null
  ) ?? topLevelTomlString(configToml, 'model')
  const modelProvider = (
    activeProfile ? profileTomlString(configToml, activeProfile, 'model_provider') : null
  ) ?? topLevelTomlString(configToml, 'model_provider') ?? 'openai'
  const models = isRecord(modelsCache) && Array.isArray(modelsCache.models)
    ? modelsCache.models
    : []

  // WHY a configured model never borrows another model's metadata: a generous
  // context window from the first visible cache entry can make capacity checks
  // pass while the projected transcript names a smaller configured model. An
  // exact miss uses the conservative fallback for that identity instead.
  const selected = models.find(candidate => (
    isRecord(candidate) && candidate.slug === configuredModel
  )) ?? (configuredModel === null
    ? models.find(candidate => isRecord(candidate) && candidate.visibility === 'list')
    : null)
  const selectedRecord = isRecord(selected) ? selected : null
  const model = configuredModel ?? (
    typeof selectedRecord?.slug === 'string' ? selectedRecord.slug : null
  )
  if (!model) {
    throw new Error('Codex target model could not be resolved from config.toml or models_cache.json.')
  }

  const contextTokens = positiveNumber(selectedRecord?.context_window) ?? 200_000
  const effectiveContextPercent = positiveNumber(
    selectedRecord?.effective_context_window_percent,
  ) ?? 90
  return {
    model,
    modelProvider,
    contextTokens,
    effectiveContextPercent,
    budgetCharacters: budgetCharactersForContextTokens(contextTokens, {
      effectiveContextPercent,
    }),
  }
}

function topLevelTomlString(source: string, key: string): string | null {
  const beforeFirstTable = source.split(/^\s*\[/m, 1)[0] ?? source
  const match = beforeFirstTable.match(
    new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']\\s*(?:#.*)?$`, 'm'),
  )
  return match?.[1] ?? null
}

function profileTomlString(source: string, profile: string, key: string): string | null {
  const escapedProfile = profile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const table = source.match(new RegExp(
    `^\\s*\\[profiles\\.${escapedProfile}\\]\\s*$([\\s\\S]*?)(?=^\\s*\\[|(?![\\s\\S]))`,
    'm',
  ))?.[1]
  if (!table) return null
  const match = table.match(
    new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']\\s*(?:#.*)?$`, 'm'),
  )
  return match?.[1] ?? null
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

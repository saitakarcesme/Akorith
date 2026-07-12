import { evaluateLoopExecutorEligibility, evaluatePlannerEligibility } from './eligibility'
import type {
  ModelCatalog,
  RoutingProfile,
  RoutingProfileIssue,
  RoutingProfileValidation
} from './types'

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+%\-]*$/

function boundedText(value: unknown, max: number, id = false): string | null {
  if (typeof value !== 'string') return null
  const clean = value.trim()
  if (!clean || clean.length > max || /[\0\r\n]/.test(clean) || (id && !ID_RE.test(clean))) return null
  return clean
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function validateRoutingProfile(
  value: unknown,
  catalog: ModelCatalog,
  now = Date.now()
): RoutingProfileValidation {
  const shapeIssues: RoutingProfileIssue[] = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, issues: [{ code: 'invalid_shape', field: 'profile', message: 'Routing profile must be an object.' }] }
  }
  const raw = value as Record<string, unknown>
  const id = boundedText(raw.id, 160, true)
  const name = boundedText(raw.name, 160)
  const plannerModelId = boundedText(raw.plannerModelId, 640, true)
  const loopExecutorModelId = boundedText(raw.loopExecutorModelId, 640, true)
  const debuggerModelId = raw.debuggerModelId === undefined ? undefined : boundedText(raw.debuggerModelId, 640, true)
  if (raw.schemaVersion !== 1) shapeIssues.push({ code: 'invalid_shape', field: 'schemaVersion', message: 'schemaVersion must be 1.' })
  if (!id) shapeIssues.push({ code: 'invalid_shape', field: 'id', message: 'Profile id is invalid.' })
  if (!name) shapeIssues.push({ code: 'invalid_shape', field: 'name', message: 'Profile name is invalid.' })
  if (!plannerModelId) shapeIssues.push({ code: 'invalid_shape', field: 'plannerModelId', message: 'Planner model id is invalid.' })
  if (!loopExecutorModelId) shapeIssues.push({ code: 'invalid_shape', field: 'loopExecutorModelId', message: 'Loop executor model id is invalid.' })
  if (raw.debuggerModelId !== undefined && !debuggerModelId) {
    shapeIssues.push({ code: 'invalid_shape', field: 'debuggerModelId', message: 'Debugger model id is invalid.' })
  }
  if (!validTimestamp(raw.createdAt)) shapeIssues.push({ code: 'invalid_shape', field: 'createdAt', message: 'createdAt is invalid.' })
  if (!validTimestamp(raw.updatedAt)) shapeIssues.push({ code: 'invalid_shape', field: 'updatedAt', message: 'updatedAt is invalid.' })
  const fallbackRaw = raw.fallbackLoopExecutorModelIds
  const fallbacks = Array.isArray(fallbackRaw)
    ? fallbackRaw.map((entry) => boundedText(entry, 640, true)).filter((entry): entry is string => entry !== null)
    : []
  if (!Array.isArray(fallbackRaw) || fallbackRaw.length > 8 || fallbacks.length !== fallbackRaw.length) {
    shapeIssues.push({ code: 'invalid_shape', field: 'fallbackLoopExecutorModelIds', message: 'Fallback executors must be an array of at most eight valid model ids.' })
  }
  if (shapeIssues.length > 0) return { ok: false, issues: shapeIssues }

  const profile: RoutingProfile = {
    schemaVersion: 1,
    id: id!,
    name: name!,
    plannerModelId: plannerModelId!,
    loopExecutorModelId: loopExecutorModelId!,
    ...(debuggerModelId ? { debuggerModelId } : {}),
    fallbackLoopExecutorModelIds: fallbacks,
    createdAt: raw.createdAt as number,
    updatedAt: raw.updatedAt as number
  }
  const issues: RoutingProfileIssue[] = []
  const uniqueFallbacks = new Set(profile.fallbackLoopExecutorModelIds)
  if (uniqueFallbacks.size !== profile.fallbackLoopExecutorModelIds.length || uniqueFallbacks.has(profile.loopExecutorModelId)) {
    issues.push({ code: 'duplicate_fallback', field: 'fallbackLoopExecutorModelIds', message: 'Fallback executors must be unique and must not repeat the primary executor.' })
  }
  const models = new Map(catalog.models.map((model) => [model.id, model]))
  const requireModel = (field: string, modelId: string) => {
    const model = models.get(modelId)
    if (!model) issues.push({ code: 'model_not_found', field, message: `Catalog model not found: ${modelId}` })
    return model
  }
  const planner = requireModel('plannerModelId', profile.plannerModelId)
  if (planner) {
    const eligibility = evaluatePlannerEligibility(planner, now)
    if (!eligibility.selectable) issues.push({ code: 'planner_ineligible', field: 'plannerModelId', message: eligibility.reason })
  }
  const executorIds: [string, string][] = [
    ['loopExecutorModelId', profile.loopExecutorModelId],
    ...profile.fallbackLoopExecutorModelIds.map((modelId, index): [string, string] => [`fallbackLoopExecutorModelIds[${index}]`, modelId])
  ]
  if (profile.debuggerModelId) executorIds.push(['debuggerModelId', profile.debuggerModelId])
  for (const [field, modelId] of executorIds) {
    const model = requireModel(field, modelId)
    if (!model) continue
    const eligibility = evaluateLoopExecutorEligibility(model, now)
    if (!eligibility.selectable) issues.push({ code: 'executor_ineligible', field, message: eligibility.reason })
  }
  return issues.length ? { ok: false, issues } : { ok: true, profile }
}

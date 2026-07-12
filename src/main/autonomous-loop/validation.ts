import {
  LOOP_STAGES,
  LOOP_STATUSES,
  type CreateAutonomousLoopInput,
  type LoopPlannedTask,
  type LoopReviewResult,
  type LoopSafetyLimits
} from './types'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/
const SAFE_MODEL = /^[^\0\r\n]{1,200}$/
const SAFE_COMMAND = /^[^\0\r\n]{1,500}$/
const MAX_TEXT = 8_000
const MAX_SHORT_TEXT = 500
const MAX_LIST = 40

export const DEFAULT_LOOP_LIMITS: Readonly<LoopSafetyLimits> = Object.freeze({
  maxRepairAttempts: 3,
  maxConsecutiveInfrastructureFailures: 5,
  tokenLimit: null,
  costLimitUsd: null,
  validationTimeoutMs: 10 * 60_000
})

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function boundedText(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized && normalized.length <= max && !normalized.includes('\0') ? normalized : null
}

function boundedTextList(value: unknown, maxItems = MAX_LIST, maxText = MAX_SHORT_TEXT): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxItems) return null
  const result: string[] = []
  for (const item of value) {
    const text = boundedText(item, maxText)
    if (!text) return null
    result.push(text)
  }
  return [...new Set(result)]
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : null
}

function findJsonObject(raw: string): string | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim()
  const candidate = fenced || raw.trim()
  const start = candidate.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = start; index < candidate.length; index += 1) {
    const char = candidate[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') quoted = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return candidate.slice(start, index + 1)
    }
  }
  return null
}

export type ParsedStructured<T> = { ok: true; value: T } | { ok: false; error: string }

export function parseLoopPlannedTask(raw: string): ParsedStructured<LoopPlannedTask> {
  if (typeof raw !== 'string' || raw.length > 200_000) return { ok: false, error: 'Planner response is not bounded text.' }
  const json = findJsonObject(raw)
  if (!json) return { ok: false, error: 'Planner did not return a JSON object.' }
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { ok: false, error: 'Planner returned invalid JSON.' }
  }
  const value = objectValue(parsed)
  if (!value) return { ok: false, error: 'Planner payload must be an object.' }

  const title = boundedText(value.title, 160)
  const proposedTask = boundedText(value.proposed_task)
  const reason = boundedText(value.reason, 2_000)
  const expectedUserValue = boundedText(value.expected_user_value, 2_000)
  const likelyAreas = boundedTextList(value.likely_areas)
  const acceptanceCriteria = boundedTextList(value.acceptance_criteria)
  const validationCommands = boundedTextList(value.validation_commands, 20, 500)
  const riskLevel = enumValue(value.risk_level, ['low', 'medium', 'high'] as const)
  const estimatedComplexity = enumValue(value.estimated_complexity, ['small', 'medium', 'large'] as const)
  const kind = enumValue(
    value.kind,
    ['code', 'test', 'documentation', 'refactor', 'bug_fix', 'infrastructure'] as const
  )

  if (!title || !proposedTask || !reason || !expectedUserValue) {
    return { ok: false, error: 'Planner task text fields are missing or too long.' }
  }
  if (!likelyAreas || !acceptanceCriteria || !validationCommands) {
    return { ok: false, error: 'Planner task lists are missing, empty, or invalid.' }
  }
  if (validationCommands.some((command) => !SAFE_COMMAND.test(command))) {
    return { ok: false, error: 'Planner validation command contains unsupported control characters.' }
  }
  if (!riskLevel || !estimatedComplexity || !kind) {
    return { ok: false, error: 'Planner risk, complexity, or task kind is invalid.' }
  }

  return {
    ok: true,
    value: {
      title,
      proposedTask,
      reason,
      expectedUserValue,
      likelyAreas,
      acceptanceCriteria,
      validationCommands,
      riskLevel,
      estimatedComplexity,
      kind
    }
  }
}

export function parseLoopReview(raw: string): ParsedStructured<LoopReviewResult> {
  if (typeof raw !== 'string' || raw.length > 200_000) return { ok: false, error: 'Review response is not bounded text.' }
  const json = findJsonObject(raw)
  if (!json) return { ok: false, error: 'Reviewer did not return a JSON object.' }
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { ok: false, error: 'Reviewer returned invalid JSON.' }
  }
  const value = objectValue(parsed)
  if (!value || typeof value.accepted !== 'boolean' || typeof value.relevant_diff !== 'boolean') {
    return { ok: false, error: 'Reviewer decision fields are invalid.' }
  }
  const rationale = boundedText(value.rationale, 4_000)
  const listKeys = [
    'acceptance_criteria_met',
    'acceptance_criteria_missed',
    'placeholders_detected',
    'deleted_tests_detected',
    'secret_findings',
    'unrelated_files',
    'generated_files_reviewed'
  ] as const
  const lists = new Map<string, string[]>()
  for (const key of listKeys) {
    const list = Array.isArray(value[key]) && value[key].length === 0 ? [] : boundedTextList(value[key])
    if (!list) return { ok: false, error: `Reviewer field ${key} is invalid.` }
    lists.set(key, list)
  }
  if (!rationale) return { ok: false, error: 'Reviewer rationale is missing.' }
  return {
    ok: true,
    value: {
      accepted: value.accepted,
      acceptanceCriteriaMet: lists.get('acceptance_criteria_met') ?? [],
      acceptanceCriteriaMissed: lists.get('acceptance_criteria_missed') ?? [],
      relevantDiff: value.relevant_diff,
      placeholdersDetected: lists.get('placeholders_detected') ?? [],
      deletedTestsDetected: lists.get('deleted_tests_detected') ?? [],
      secretFindings: lists.get('secret_findings') ?? [],
      unrelatedFiles: lists.get('unrelated_files') ?? [],
      generatedFilesReviewed: lists.get('generated_files_reviewed') ?? [],
      rationale
    }
  }
}

export function normalizeLoopLimits(value: Partial<LoopSafetyLimits> | undefined): LoopSafetyLimits {
  const integer = (candidate: unknown, fallback: number, min: number, max: number): number =>
    Number.isInteger(candidate) && Number(candidate) >= min && Number(candidate) <= max ? Number(candidate) : fallback
  const nullableNumber = (candidate: unknown, max: number): number | null =>
    candidate === null || candidate === undefined
      ? null
      : typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0 && candidate <= max
        ? candidate
        : null
  return {
    maxRepairAttempts: integer(value?.maxRepairAttempts, DEFAULT_LOOP_LIMITS.maxRepairAttempts, 1, 10),
    maxConsecutiveInfrastructureFailures: integer(
      value?.maxConsecutiveInfrastructureFailures,
      DEFAULT_LOOP_LIMITS.maxConsecutiveInfrastructureFailures,
      1,
      20
    ),
    tokenLimit: nullableNumber(value?.tokenLimit, 1_000_000_000),
    costLimitUsd: nullableNumber(value?.costLimitUsd, 1_000_000),
    validationTimeoutMs: integer(value?.validationTimeoutMs, DEFAULT_LOOP_LIMITS.validationTimeoutMs, 5_000, 3_600_000)
  }
}

export function validateCreateAutonomousLoopInput(input: unknown): ParsedStructured<CreateAutonomousLoopInput> {
  const value = objectValue(input)
  const source = objectValue(value?.source)
  const executor = objectValue(value?.executor)
  const planner = value?.planner === undefined ? undefined : objectValue(value.planner)
  if (!value || !source || !executor || planner === null) return { ok: false, error: 'Loop setup payload is invalid.' }
  if (source.kind !== 'new' && source.kind !== 'existing_github') return { ok: false, error: 'Project source is invalid.' }

  const sourceValue =
    source.kind === 'new'
      ? {
          kind: 'new' as const,
          parentPath: boundedText(source.parentPath, 2_000),
          projectName: boundedText(source.projectName, 120),
          remoteUrl: source.remoteUrl === undefined ? undefined : boundedText(source.remoteUrl, 2_000),
          createRemoteWithPlugin: source.createRemoteWithPlugin === true
        }
      : {
          kind: 'existing_github' as const,
          remoteUrl: boundedText(source.remoteUrl, 2_000)
        }
  if (
    (sourceValue.kind === 'new' && (!sourceValue.parentPath || !sourceValue.projectName)) ||
    (sourceValue.kind === 'existing_github' && !sourceValue.remoteUrl)
  ) {
    return { ok: false, error: 'Project source fields are missing.' }
  }

  const parseSelection = (candidate: Record<string, unknown>, needsProbe: boolean) => {
    const catalogId = boundedText(candidate.catalogId, 160)
    const providerId = boundedText(candidate.providerId, 80)
    const model = boundedText(candidate.model, 200)
    const location = enumValue(candidate.location, ['local', 'remote', 'cloud'] as const)
    const nodeId = candidate.nodeId === undefined ? undefined : boundedText(candidate.nodeId, 160)
    const capabilityProbeId = needsProbe ? boundedText(candidate.capabilityProbeId, 160) : undefined
    if (
      !catalogId ||
      !providerId ||
      !model ||
      !location ||
      !SAFE_ID.test(catalogId) ||
      !SAFE_ID.test(providerId) ||
      !SAFE_MODEL.test(model) ||
      (nodeId !== undefined && (!nodeId || !SAFE_ID.test(nodeId))) ||
      (needsProbe && (!capabilityProbeId || !SAFE_ID.test(capabilityProbeId)))
    ) return null
    return { catalogId, providerId, model, location, nodeId, capabilityProbeId }
  }

  const executorValue = parseSelection(executor, true)
  const plannerValue = planner ? parseSelection(planner, false) : undefined
  if (!executorValue || (planner && !plannerValue)) return { ok: false, error: 'Model selection is invalid.' }

  return {
    ok: true,
    value: {
      source: sourceValue as CreateAutonomousLoopInput['source'],
      executor: executorValue as CreateAutonomousLoopInput['executor'],
      planner: plannerValue as CreateAutonomousLoopInput['planner'],
      limits: normalizeLoopLimits(objectValue(value.limits) as Partial<LoopSafetyLimits> | undefined)
    }
  }
}

export function isAutonomousLoopStatus(value: unknown): boolean {
  return enumValue(value, LOOP_STATUSES) !== null
}

export function isAutonomousLoopStage(value: unknown): boolean {
  return enumValue(value, LOOP_STAGES) !== null
}

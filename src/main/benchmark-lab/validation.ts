import {
  BENCHMARK_CATEGORIES,
  BENCHMARK_LANGUAGES,
  BENCHMARK_SCHEMA_VERSION,
  type BenchmarkEvidenceSource,
  type BenchmarkExecutorOutput,
  type BenchmarkFixture,
  type BenchmarkFixtureRun,
  type BenchmarkModelRun,
  type BenchmarkModelTarget,
  type BenchmarkPlannerOutput,
  type BenchmarkRunConfiguration,
  type BenchmarkSuite,
  type BenchmarkUsageMetadata,
  type BenchmarkValidationEvidence,
  type BenchmarkValidationObservation
} from './types'
import { benchmarkCompatibilityKey } from './comparability'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/
const SAFE_DIGEST = /^[a-f0-9]{64}$/i
const MAX_SHORT_TEXT = 500
const MAX_LONG_TEXT = 100_000
const MAX_FIXTURES = 200
const MAX_FILES = 100
const MAX_REQUIREMENTS = 50
const MAX_LIST = 100

export type BenchmarkParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] }

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown, max = MAX_SHORT_TEXT): string | null {
  if (typeof value !== 'string' || value.includes('\0')) return null
  const normalized = value.trim()
  return normalized.length > 0 && normalized.length <= max ? normalized : null
}

function optionalText(value: unknown, max = MAX_SHORT_TEXT): string | null | undefined {
  return value === null ? null : text(value, max) ?? undefined
}

function integer(value: unknown, min: number, max: number): number | null {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max ? Number(value) : null
}

function finite(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : null
}

function safeRelativePath(value: unknown): string | null {
  const candidate = text(value, 1_000)?.replace(/\\/g, '/')
  if (!candidate || candidate.startsWith('/') || /^[A-Za-z]:\//.test(candidate)) return null
  const parts = candidate.split('/')
  return parts.some((part) => !part || part === '.' || part === '..') ? null : candidate
}

function uniqueTextList(value: unknown, allowed: readonly string[] | null = null): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_LIST) return null
  const result: string[] = []
  for (const item of value) {
    const parsed = text(item, 160)
    if (!parsed || (allowed && !allowed.includes(parsed))) return null
    if (!result.includes(parsed)) result.push(parsed)
  }
  return result
}

export function validateUsageMetadata(value: unknown): BenchmarkParseResult<BenchmarkUsageMetadata> {
  const input = objectValue(value)
  const errors: string[] = []
  const source = enumValue(input?.source, ['reported', 'estimated', 'unavailable'] as const)
  if (!source) errors.push('usage source is invalid')
  const parseNullable = (key: string, max: number): number | null | undefined => {
    if (input?.[key] === null) return null
    const parsed = finite(input?.[key], 0, max)
    if (parsed === null) errors.push(`${key} must be null or a non-negative finite number`)
    return parsed ?? undefined
  }
  const inputTokens = parseNullable('inputTokens', 10_000_000_000)
  const outputTokens = parseNullable('outputTokens', 10_000_000_000)
  const cachedTokens = parseNullable('cachedTokens', 10_000_000_000)
  const costUsd = parseNullable('costUsd', 100_000_000)
  if (source === 'unavailable' && [inputTokens, outputTokens, cachedTokens, costUsd].some((item) => item !== null)) {
    errors.push('unavailable usage must not contain invented numeric values')
  }
  if (
    (source === 'reported' || source === 'estimated') &&
    [inputTokens, outputTokens, cachedTokens, costUsd].every((item) => item === null)
  ) {
    errors.push(`${source} usage must contain at least one measured value`)
  }
  return errors.length
    ? { ok: false, errors }
    : {
        ok: true,
        value: {
          source: source!,
          inputTokens: inputTokens as number | null,
          outputTokens: outputTokens as number | null,
          cachedTokens: cachedTokens as number | null,
          costUsd: costUsd as number | null
        }
      }
}

function parseFixture(value: unknown, path: string): BenchmarkParseResult<BenchmarkFixture> {
  const input = objectValue(value)
  const errors: string[] = []
  if (input?.schemaVersion !== BENCHMARK_SCHEMA_VERSION) errors.push(`${path}.schemaVersion must be 1`)
  const id = text(input?.id, 160)
  if (!id || !SAFE_ID.test(id)) errors.push(`${path}.id is invalid`)
  const revision = integer(input?.revision, 1, 1_000_000)
  if (revision === null) errors.push(`${path}.revision is invalid`)
  const category = enumValue(input?.category, BENCHMARK_CATEGORIES)
  if (!category) errors.push(`${path}.category is invalid`)
  const title = text(input?.title, 200)
  const summary = text(input?.summary, 2_000)
  const taskPrompt = text(input?.taskPrompt, MAX_LONG_TEXT)
  if (!title || !summary || !taskPrompt) errors.push(`${path} text fields are missing or too long`)
  const seed = integer(input?.seed, 0, 0xffffffff)
  const timeoutMs = integer(input?.timeoutMs, 1_000, 3_600_000)
  if (seed === null || timeoutMs === null) errors.push(`${path} seed or timeout is invalid`)
  const languages = uniqueTextList(input?.languages, BENCHMARK_LANGUAGES)
  const tags = uniqueTextList(input?.tags)
  if (!languages || !tags) errors.push(`${path} language or tag list is invalid`)

  const workspaceFiles: BenchmarkFixture['workspaceFiles'] = []
  if (!Array.isArray(input?.workspaceFiles) || input.workspaceFiles.length > MAX_FILES) {
    errors.push(`${path}.workspaceFiles is invalid`)
  } else {
    const paths = new Set<string>()
    for (const [index, entry] of input.workspaceFiles.entries()) {
      const file = objectValue(entry)
      const relativePath = safeRelativePath(file?.path)
      const content = typeof file?.content === 'string' && file.content.length <= MAX_LONG_TEXT && !file.content.includes('\0')
        ? file.content
        : null
      if (!relativePath || content === null || paths.has(relativePath.toLowerCase())) {
        errors.push(`${path}.workspaceFiles[${index}] is invalid or duplicated`)
      } else {
        paths.add(relativePath.toLowerCase())
        workspaceFiles.push({ path: relativePath, content })
      }
    }
  }

  const validation: BenchmarkFixture['validation'] = []
  if (!Array.isArray(input?.validation) || input.validation.length < 1 || input.validation.length > MAX_REQUIREMENTS) {
    errors.push(`${path}.validation must contain 1-${MAX_REQUIREMENTS} requirements`)
  } else {
    const ids = new Set<string>()
    for (const [index, entry] of input.validation.entries()) {
      const requirement = objectValue(entry)
      const requirementId = text(requirement?.id, 160)
      const label = text(requirement?.label, 1_000)
      const kind = enumValue(
        requirement?.kind,
        ['test_command', 'behavior_assertion', 'artifact_check', 'repository_assertion'] as const
      )
      const weight = integer(requirement?.weight, 1, 100)
      if (!requirementId || !SAFE_ID.test(requirementId) || ids.has(requirementId) || !label || !kind || weight === null || typeof requirement?.mandatory !== 'boolean') {
        errors.push(`${path}.validation[${index}] is invalid or duplicated`)
      } else {
        ids.add(requirementId)
        validation.push({ id: requirementId, label, kind, weight, mandatory: requirement.mandatory })
      }
    }
  }

  return errors.length
    ? { ok: false, errors }
    : {
        ok: true,
        value: {
          schemaVersion: 1,
          id: id!,
          revision: revision!,
          category: category!,
          title: title!,
          summary: summary!,
          taskPrompt: taskPrompt!,
          seed: seed!,
          timeoutMs: timeoutMs!,
          languages: languages as BenchmarkFixture['languages'],
          tags: tags!,
          workspaceFiles,
          validation
        }
      }
}

export function validateBenchmarkSuite(value: unknown): BenchmarkParseResult<BenchmarkSuite> {
  const input = objectValue(value)
  const errors: string[] = []
  if (input?.schemaVersion !== BENCHMARK_SCHEMA_VERSION) errors.push('suite.schemaVersion must be 1')
  const id = text(input?.id, 160)
  if (!id || !SAFE_ID.test(id)) errors.push('suite.id is invalid')
  const revision = integer(input?.revision, 1, 1_000_000)
  const seed = integer(input?.seed, 0, 0xffffffff)
  const defaultTimeoutMs = integer(input?.defaultTimeoutMs, 1_000, 3_600_000)
  const createdAt = integer(input?.createdAt, 0, Number.MAX_SAFE_INTEGER)
  const name = text(input?.name, 200)
  const description = text(input?.description, 4_000)
  if (revision === null || seed === null || defaultTimeoutMs === null || createdAt === null) errors.push('suite numeric fields are invalid')
  if (!name || !description) errors.push('suite text fields are invalid')

  const fixtures: BenchmarkFixture[] = []
  const fixtureIds = new Set<string>()
  if (!Array.isArray(input?.fixtures) || input.fixtures.length < BENCHMARK_CATEGORIES.length || input.fixtures.length > MAX_FIXTURES) {
    errors.push(`suite.fixtures must contain ${BENCHMARK_CATEGORIES.length}-${MAX_FIXTURES} fixtures`)
  } else {
    for (const [index, fixture] of input.fixtures.entries()) {
      const parsed = parseFixture(fixture, `suite.fixtures[${index}]`)
      if (!parsed.ok) errors.push(...parsed.errors)
      else if (fixtureIds.has(parsed.value.id)) errors.push(`suite fixture id ${parsed.value.id} is duplicated`)
      else {
        fixtureIds.add(parsed.value.id)
        fixtures.push(parsed.value)
      }
    }
  }

  for (const category of BENCHMARK_CATEGORIES) {
    if (!fixtures.some((fixture) => fixture.category === category)) errors.push(`suite is missing category ${category}`)
  }
  const multiLanguages = new Set(fixtures.filter((fixture) => fixture.category === 'multi_language').flatMap((fixture) => fixture.languages))
  for (const language of BENCHMARK_LANGUAGES) {
    if (!multiLanguages.has(language)) errors.push(`multi-language fixtures are missing ${language}`)
  }

  return errors.length
    ? { ok: false, errors }
    : {
        ok: true,
        value: {
          schemaVersion: 1,
          id: id!,
          revision: revision!,
          name: name!,
          description: description!,
          seed: seed!,
          defaultTimeoutMs: defaultTimeoutMs!,
          fixtures,
          createdAt: createdAt!
        }
      }
}

export function validateModelTarget(value: unknown): BenchmarkParseResult<BenchmarkModelTarget> {
  const input = objectValue(value)
  const errors: string[] = []
  const catalogModelId = text(input?.catalogModelId, 160)
  const providerId = text(input?.providerId, 160)
  const model = text(input?.model, 300)
  const location = enumValue(input?.location, ['local', 'remote', 'cloud'] as const)
  const nodeId = input?.nodeId === null ? null : text(input?.nodeId, 160)
  const quantization = input?.quantization === null ? null : text(input?.quantization, 120)
  const contextWindowTokens = input?.contextWindowTokens === null ? null : integer(input?.contextWindowTokens, 1, 100_000_000)
  if (!catalogModelId || !SAFE_ID.test(catalogModelId)) errors.push('target.catalogModelId is invalid')
  if (!providerId || !SAFE_ID.test(providerId)) errors.push('target.providerId is invalid')
  if (!model || !location) errors.push('target model or location is invalid')
  if (input?.nodeId !== null && (!nodeId || !SAFE_ID.test(nodeId))) errors.push('target.nodeId is invalid')
  if (input?.quantization !== null && !quantization) errors.push('target.quantization is invalid')
  if (input?.contextWindowTokens !== null && contextWindowTokens === null) errors.push('target.contextWindowTokens is invalid')
  return errors.length
    ? { ok: false, errors }
    : { ok: true, value: { catalogModelId: catalogModelId!, providerId: providerId!, model: model!, location: location!, nodeId, quantization, contextWindowTokens } }
}

function parseParameterRecord(value: unknown, stringOnly: boolean): BenchmarkParseResult<Record<string, string | number | boolean | null>> {
  const input = objectValue(value)
  if (!input || Object.keys(input).length > 50) return { ok: false, errors: ['parameter record is invalid or too large'] }
  const output: Record<string, string | number | boolean | null> = {}
  const errors: string[] = []
  for (const [key, entry] of Object.entries(input)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(key)) {
      errors.push(`parameter key ${key.slice(0, 80)} is invalid`)
      continue
    }
    if (stringOnly) {
      const parsed = text(entry, 200)
      if (!parsed) errors.push(`parameter ${key} must be bounded text`)
      else output[key] = parsed
    } else if (entry === null || typeof entry === 'boolean' || (typeof entry === 'number' && Number.isFinite(entry)) || (typeof entry === 'string' && entry.length <= 500 && !entry.includes('\0'))) {
      output[key] = entry
    } else errors.push(`parameter ${key} has an unsupported value`)
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: output }
}

export function validateBenchmarkRunConfiguration(value: unknown): BenchmarkParseResult<BenchmarkRunConfiguration> {
  const input = objectValue(value)
  const errors: string[] = []
  if (input?.schemaVersion !== 1) errors.push('configuration.schemaVersion must be 1')
  const harnessVersion = text(input?.harnessVersion, 80)
  const instructionProfileId = text(input?.instructionProfileId, 160)
  const maxAttempts = integer(input?.maxAttempts, 1, 20)
  const repetitionIndex = integer(input?.repetitionIndex, 1, 100)
  const repetitionCount = integer(input?.repetitionCount, 1, 100)
  if (!harnessVersion || !instructionProfileId || maxAttempts === null || repetitionIndex === null || repetitionCount === null || (repetitionIndex ?? 1) > (repetitionCount ?? 0)) {
    errors.push('configuration identity, attempts, or repetition fields are invalid')
  }
  const temperatureInput = objectValue(input?.temperature)
  const support = enumValue(temperatureInput?.support, ['supported', 'unsupported', 'unknown'] as const)
  const requested = temperatureInput?.requested === null ? null : finite(temperatureInput?.requested, 0, 2)
  const applied = temperatureInput?.applied === null ? null : finite(temperatureInput?.applied, 0, 2)
  if (!support || (temperatureInput?.requested !== null && requested === null) || (temperatureInput?.applied !== null && applied === null)) {
    errors.push('configuration temperature is invalid')
  }
  if (support !== 'supported' && applied !== null) errors.push('unsupported or unknown temperature cannot claim an applied value')
  if (support === 'supported' && applied === null) errors.push('supported temperature must record the applied value')
  const providerParameters = parseParameterRecord(input?.providerParameters, false)
  const dependencies = parseParameterRecord(input?.dependencyVersions, true)
  const unsupportedParameters = uniqueTextList(input?.unsupportedParameters)
  if (!providerParameters.ok) errors.push(...providerParameters.errors)
  if (!dependencies.ok) errors.push(...dependencies.errors)
  if (!unsupportedParameters) errors.push('configuration.unsupportedParameters is invalid')
  const environmentImage = input?.environmentImage === null ? null : text(input?.environmentImage, 500)
  if (input?.environmentImage !== null && !environmentImage) errors.push('configuration.environmentImage is invalid')

  const hardwareInput = objectValue(input?.hardware)
  const hardwareSource = enumValue(hardwareInput?.source, ['observed', 'reported', 'unavailable'] as const)
  const hardwareText = (key: string, max = 300): string | null | undefined => hardwareInput?.[key] === null ? null : text(hardwareInput?.[key], max) ?? undefined
  const platform = hardwareText('platform')
  const architecture = hardwareText('architecture')
  const cpuModel = hardwareText('cpuModel')
  const gpuModel = hardwareText('gpuModel')
  const nodeId = hardwareText('nodeId', 160)
  const hardwareNumber = (key: string, max: number): number | null | undefined => hardwareInput?.[key] === null ? null : finite(hardwareInput?.[key], 0, max) ?? undefined
  const cpuLogicalCores = hardwareNumber('cpuLogicalCores', 1_024)
  const ramMb = hardwareNumber('ramMb', 100_000_000)
  const vramMb = hardwareNumber('vramMb', 100_000_000)
  if (!hardwareSource || [platform, architecture, cpuModel, gpuModel, nodeId, cpuLogicalCores, ramMb, vramMb].some((entry) => entry === undefined)) {
    errors.push('configuration.hardware is invalid')
  }
  if (hardwareSource === 'unavailable' && [platform, architecture, cpuModel, gpuModel, cpuLogicalCores, ramMb, vramMb].some((entry) => entry !== null)) {
    errors.push('unavailable hardware cannot claim observed hardware values')
  }
  if ((hardwareSource === 'observed' || hardwareSource === 'reported') && [platform, architecture, cpuModel, gpuModel, cpuLogicalCores, ramMb, vramMb].every((entry) => entry === null)) {
    errors.push(`${hardwareSource} hardware must contain at least one value`)
  }

  return errors.length ? { ok: false, errors } : {
    ok: true,
    value: {
      schemaVersion: 1,
      harnessVersion: harnessVersion!,
      instructionProfileId: instructionProfileId!,
      maxAttempts: maxAttempts!,
      temperature: { support: support!, requested, applied },
      providerParameters: providerParameters.ok ? providerParameters.value : {},
      unsupportedParameters: unsupportedParameters!,
      repetitionIndex: repetitionIndex!,
      repetitionCount: repetitionCount!,
      hardware: {
        source: hardwareSource!, platform: platform!, architecture: architecture!, cpuModel: cpuModel!,
        cpuLogicalCores: cpuLogicalCores!, ramMb: ramMb!, gpuModel: gpuModel!, vramMb: vramMb!, nodeId: nodeId!
      },
      dependencyVersions: dependencies.ok ? dependencies.value as Record<string, string> : {},
      environmentImage
    }
  }
}

export function validatePlannerOutput(value: unknown): BenchmarkParseResult<BenchmarkPlannerOutput> {
  const input = objectValue(value)
  const usage = validateUsageMetadata(input?.usage)
  const plan = text(input?.plan, MAX_LONG_TEXT)
  const summary = text(input?.summary, 4_000)
  const errors = [...(usage.ok ? [] : usage.errors)]
  if (!plan || !summary) errors.push('planner output text is invalid')
  return errors.length ? { ok: false, errors } : { ok: true, value: { plan: plan!, summary: summary!, usage: usage.ok ? usage.value : unavailableUsage() } }
}

export function validateExecutorOutput(value: unknown): BenchmarkParseResult<BenchmarkExecutorOutput> {
  const input = objectValue(value)
  const usage = validateUsageMetadata(input?.usage)
  const status = enumValue(input?.status, ['completed', 'failed'] as const)
  const summary = text(input?.summary, 8_000)
  const artifactReferences = uniqueTextList(input?.artifactReferences)
  const error = optionalText(input?.error, 4_000)
  const errors = [...(usage.ok ? [] : usage.errors)]
  if (!status || !summary || !artifactReferences || error === undefined) errors.push('executor output is invalid')
  if (status === 'failed' && error === null) errors.push('failed executor output requires an error')
  return errors.length
    ? { ok: false, errors }
    : {
        ok: true,
        value: { status: status!, summary: summary!, artifactReferences: artifactReferences!, usage: usage.ok ? usage.value : unavailableUsage(), error: error! }
      }
}

function parseObservation(value: unknown, path: string): BenchmarkParseResult<BenchmarkValidationObservation> {
  const input = objectValue(value)
  const errors: string[] = []
  const requirementId = text(input?.requirementId, 160)
  const source = enumValue(
    input?.source,
    ['process', 'filesystem', 'structured_parser', 'deterministic_mock'] as const satisfies readonly BenchmarkEvidenceSource[]
  )
  const observedAt = integer(input?.observedAt, 0, Number.MAX_SAFE_INTEGER)
  const summary = text(input?.summary, 4_000)
  if (!requirementId || !SAFE_ID.test(requirementId) || !source || observedAt === null || !summary || typeof input?.passed !== 'boolean') {
    errors.push(`${path} core fields are invalid`)
  }
  let process: BenchmarkValidationObservation['process'] = null
  if (input?.process !== null) {
    const processInput = objectValue(input?.process)
    const commandLabel = text(processInput?.commandLabel, 1_000)
    const exitCode = processInput?.exitCode === null ? null : integer(processInput?.exitCode, -2_147_483_648, 2_147_483_647)
    const timedOut = processInput?.timedOut
    const durationMs = finite(processInput?.durationMs, 0, 86_400_000)
    const stdoutDigest = processInput?.stdoutDigest === null ? null : text(processInput?.stdoutDigest, 160)
    const stderrDigest = processInput?.stderrDigest === null ? null : text(processInput?.stderrDigest, 160)
    if (!commandLabel || exitCode === null && processInput?.exitCode !== null || typeof timedOut !== 'boolean' || durationMs === null ||
      (stdoutDigest !== null && !SAFE_DIGEST.test(stdoutDigest)) || (stderrDigest !== null && !SAFE_DIGEST.test(stderrDigest))) {
      errors.push(`${path}.process is invalid`)
    } else {
      process = { commandLabel, exitCode, timedOut, durationMs, stdoutDigest, stderrDigest }
    }
  }
  let filesystem: BenchmarkValidationObservation['filesystem'] = null
  if (input?.filesystem !== null) {
    const filesystemInput = objectValue(input?.filesystem)
    const relativePath = safeRelativePath(filesystemInput?.relativePath)
    const sha256 = filesystemInput?.sha256 === null ? null : text(filesystemInput?.sha256, 160)
    if (!relativePath || (sha256 !== null && !SAFE_DIGEST.test(sha256))) errors.push(`${path}.filesystem is invalid`)
    else filesystem = { relativePath, sha256 }
  }
  if (source === 'process' && !process) errors.push(`${path} process source requires process evidence`)
  if (source === 'filesystem' && !filesystem) errors.push(`${path} filesystem source requires filesystem evidence`)
  return errors.length
    ? { ok: false, errors }
    : { ok: true, value: { requirementId: requirementId!, passed: input!.passed as boolean, observedAt: observedAt!, source: source!, summary: summary!, process, filesystem } }
}

export function validateEvidence(
  value: unknown,
  fixture: BenchmarkFixture,
  mode: 'production' | 'simulation'
): BenchmarkParseResult<BenchmarkValidationEvidence> {
  const input = objectValue(value)
  const errors: string[] = []
  if (input?.schemaVersion !== BENCHMARK_SCHEMA_VERSION) errors.push('evidence.schemaVersion must be 1')
  const validatorId = text(input?.validatorId, 160)
  const validatorVersion = text(input?.validatorVersion, 80)
  const capturedAt = integer(input?.capturedAt, 0, Number.MAX_SAFE_INTEGER)
  if (!validatorId || !SAFE_ID.test(validatorId) || !validatorVersion || capturedAt === null) errors.push('evidence validator fields are invalid')
  if (input?.fixtureId !== fixture.id || input?.fixtureRevision !== fixture.revision) errors.push('evidence fixture identity does not match')
  if (typeof input?.simulated !== 'boolean') errors.push('evidence.simulated must be boolean')
  if (mode === 'production' && input?.simulated !== false) errors.push('simulated evidence is forbidden in production runs')
  const logsDigest = input?.logsDigest === null ? null : text(input?.logsDigest, 160)
  if (logsDigest !== null && (!logsDigest || !SAFE_DIGEST.test(logsDigest))) errors.push('evidence.logsDigest is invalid')

  const observations: BenchmarkValidationObservation[] = []
  const seen = new Set<string>()
  if (!Array.isArray(input?.observations) || input.observations.length !== fixture.validation.length) {
    errors.push('evidence must include exactly one observation per validation requirement')
  } else {
    for (const [index, observation] of input.observations.entries()) {
      const parsed = parseObservation(observation, `evidence.observations[${index}]`)
      if (!parsed.ok) errors.push(...parsed.errors)
      else if (seen.has(parsed.value.requirementId)) errors.push(`duplicate observation ${parsed.value.requirementId}`)
      else {
        seen.add(parsed.value.requirementId)
        observations.push(parsed.value)
      }
    }
  }
  for (const requirement of fixture.validation) {
    if (!seen.has(requirement.id)) errors.push(`evidence is missing ${requirement.id}`)
  }
  if (mode === 'production' && observations.some((observation) => observation.source === 'deterministic_mock')) {
    errors.push('deterministic mock observations are forbidden in production runs')
  }
  if (input?.simulated === false && observations.some((observation) => observation.source === 'deterministic_mock')) {
    errors.push('mock observations must declare evidence as simulated')
  }
  return errors.length
    ? { ok: false, errors }
    : {
        ok: true,
        value: {
          schemaVersion: 1,
          validatorId: validatorId!,
          validatorVersion: validatorVersion!,
          fixtureId: fixture.id,
          fixtureRevision: fixture.revision,
          capturedAt: capturedAt!,
          simulated: input!.simulated as boolean,
          observations,
          logsDigest
        }
      }
}

function parseFixtureRun(value: unknown, fixture: BenchmarkFixture): BenchmarkParseResult<BenchmarkFixtureRun> {
  const input = objectValue(value)
  const errors: string[] = []
  if (input?.schemaVersion !== 1 || input?.fixtureId !== fixture.id || input?.fixtureRevision !== fixture.revision || input?.category !== fixture.category) {
    errors.push(`fixture run identity does not match ${fixture.id}`)
  }
  const id = text(input?.id, 200)
  const seed = integer(input?.seed, 0, 0xffffffff)
  const timeoutMs = integer(input?.timeoutMs, 1_000, 3_600_000)
  const status = enumValue(input?.status, ['queued', 'planning', 'executing', 'validating', 'completed', 'failed', 'timed_out', 'cancelled', 'invalid_evidence'] as const)
  const startedAt = integer(input?.startedAt, 0, Number.MAX_SAFE_INTEGER)
  const finishedAt = integer(input?.finishedAt, 0, Number.MAX_SAFE_INTEGER)
  const durationMs = finite(input?.durationMs, 0, 86_400_000)
  if (!id || !SAFE_ID.test(id) || seed === null || timeoutMs === null || !status || startedAt === null || finishedAt === null || durationMs === null) {
    errors.push(`fixture run core fields are invalid for ${fixture.id}`)
  }
  if (startedAt !== null && finishedAt !== null && finishedAt < startedAt) errors.push(`fixture run timestamps are reversed for ${fixture.id}`)
  const evidence = input?.evidence === null ? null : validateEvidence(input?.evidence, fixture, input?.evidence && objectValue(input.evidence)?.simulated === true ? 'simulation' : 'production')
  if (evidence && !evidence.ok) errors.push(...evidence.errors)
  if (status === 'completed' && (!evidence || !evidence.ok)) errors.push(`completed fixture ${fixture.id} requires valid evidence`)
  const artifactReferences = uniqueTextList(input?.artifactReferences)
  const plannerSummary = optionalText(input?.plannerSummary, 4_000)
  const executorSummary = optionalText(input?.executorSummary, 8_000)
  const errorCode = optionalText(input?.errorCode, 160)
  const error = optionalText(input?.error, 4_000)
  if (!artifactReferences || plannerSummary === undefined || executorSummary === undefined || errorCode === undefined || error === undefined) {
    errors.push(`fixture run metadata is invalid for ${fixture.id}`)
  }
  const parseStage = (stage: unknown, label: string) => {
    if (stage === null) return null
    const stageInput = objectValue(stage)
    const latencyMs = finite(stageInput?.latencyMs, 0, 86_400_000)
    const usage = validateUsageMetadata(stageInput?.usage)
    if (latencyMs === null || !usage.ok) {
      errors.push(`${label} metrics are invalid`)
      return null
    }
    return { latencyMs, usage: usage.value }
  }
  const planner = parseStage(input?.planner, `${fixture.id} planner`)
  const executor = parseStage(input?.executor, `${fixture.id} executor`)
  if (status === 'completed' && (!planner || !executor || plannerSummary === null || executorSummary === null)) {
    errors.push(`completed fixture ${fixture.id} requires planner and executor metrics`)
  }
  return errors.length
    ? { ok: false, errors }
    : {
        ok: true,
        value: {
          schemaVersion: 1,
          id: id!, fixtureId: fixture.id, fixtureRevision: fixture.revision, category: fixture.category,
          seed: seed!, timeoutMs: timeoutMs!, status: status!, startedAt: startedAt!, finishedAt: finishedAt!, durationMs: durationMs!,
          planner, executor, plannerSummary: plannerSummary!, executorSummary: executorSummary!, artifactReferences: artifactReferences!,
          evidence: evidence && evidence.ok ? evidence.value : null, errorCode: errorCode!, error: error!
        }
      }
}

export function validateBenchmarkModelRun(value: unknown, suite: BenchmarkSuite): BenchmarkParseResult<BenchmarkModelRun> {
  const input = objectValue(value)
  const errors: string[] = []
  if (input?.schemaVersion !== 1 || input?.suiteId !== suite.id || input?.suiteRevision !== suite.revision) {
    errors.push('model run suite identity is invalid')
  }
  const id = text(input?.id, 160)
  const mode = enumValue(input?.mode, ['production', 'simulation'] as const)
  const status = enumValue(input?.status, ['running', 'completed', 'partial', 'failed', 'cancelled'] as const)
  const suiteSeed = integer(input?.suiteSeed, 0, 0xffffffff)
  const target = validateModelTarget(input?.target)
  const configuration = validateBenchmarkRunConfiguration(input?.configuration)
  const compatibilityKey = text(input?.compatibilityKey, 64)
  const startedAt = integer(input?.startedAt, 0, Number.MAX_SAFE_INTEGER)
  const finishedAt = input?.finishedAt === null ? null : integer(input?.finishedAt, 0, Number.MAX_SAFE_INTEGER)
  const error = optionalText(input?.error, 4_000)
  if (!id || !SAFE_ID.test(id) || !mode || !status || suiteSeed === null || !target.ok || !configuration.ok || !compatibilityKey || !/^[a-f0-9]{64}$/i.test(compatibilityKey) || startedAt === null || (input?.finishedAt !== null && finishedAt === null) || error === undefined) {
    errors.push('model run core fields are invalid')
  }
  if (!configuration.ok) errors.push(...configuration.errors)
  else if (compatibilityKey !== benchmarkCompatibilityKey(configuration.value)) errors.push('model run compatibility key does not match its configuration')
  if (status !== 'running' && finishedAt === null) errors.push('finished model run requires finishedAt')
  if (status === 'running' && finishedAt !== null) errors.push('running model run cannot have finishedAt')
  if (startedAt !== null && finishedAt !== null && finishedAt < startedAt) errors.push('model run timestamps are reversed')
  const fixtureRuns: BenchmarkFixtureRun[] = []
  if (!Array.isArray(input?.fixtureRuns) || input.fixtureRuns.length > suite.fixtures.length) errors.push('model run fixtureRuns is invalid')
  else {
    for (const [index, candidate] of input.fixtureRuns.entries()) {
      const candidateInput = objectValue(candidate)
      const fixture = suite.fixtures.find((entry) => entry.id === candidateInput?.fixtureId)
      if (!fixture) errors.push(`model run fixtureRuns[${index}] references an unknown fixture`)
      else {
        const parsed = parseFixtureRun(candidate, fixture)
        if (!parsed.ok) errors.push(...parsed.errors)
        else fixtureRuns.push(parsed.value)
      }
    }
  }
  if (new Set(fixtureRuns.map((run) => run.fixtureId)).size !== fixtureRuns.length) errors.push('model run contains duplicate fixture runs')
  if (status === 'completed' && (fixtureRuns.length !== suite.fixtures.length || fixtureRuns.some((run) => run.status !== 'completed'))) {
    errors.push('completed model run requires every suite fixture to be completed')
  }
  if (mode === 'production' && fixtureRuns.some((run) => run.evidence?.simulated)) errors.push('production model run contains simulated evidence')
  return errors.length
    ? { ok: false, errors }
    : {
        ok: true,
        value: {
          schemaVersion: 1, id: id!, suiteId: suite.id, suiteRevision: suite.revision, suiteSeed: suiteSeed!,
          mode: mode!, target: target.ok ? target.value : (null as never),
          configuration: configuration.ok ? configuration.value : (null as never), compatibilityKey: compatibilityKey!,
          status: status!, startedAt: startedAt!,
          finishedAt, fixtureRuns, error: error!
        }
      }
}

export function unavailableUsage(): BenchmarkUsageMetadata {
  return { source: 'unavailable', inputTokens: null, outputTokens: null, cachedTokens: null, costUsd: null }
}

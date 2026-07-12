import assert from 'node:assert/strict'
import {
  LOOP_EXECUTOR_MANDATORY_CAPABILITIES,
  MODEL_CAPABILITIES,
  buildModelCatalog,
  evaluateLoopExecutorEligibility,
  evaluatePlannerEligibility,
  inferProviderFamily,
  mergeCapabilityDeclarations,
  mergeProbeCapabilities,
  probeFreshness,
  stableCatalogModelId,
  validateProbeRecord,
  validateRoutingProfile,
  type BuildModelCatalogInput,
  type CapabilityDeclaration,
  type CatalogModel,
  type ModelCapability,
  type ModelCapabilityProbeRecord,
  type ProviderCatalogSnapshot,
  type RegistryProviderSnapshot,
  type RemoteNodeCatalogSnapshot
} from '../src/main/model-catalog/index.ts'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 6, 12, 12, 0, 0)

const fullExecutorDeclaration = Object.fromEntries(
  LOOP_EXECUTOR_MANDATORY_CAPABILITIES.map((capability) => [capability, true])
) as CapabilityDeclaration

function fullProbe(input: {
  id: string
  model: CatalogModel
  completedAt?: number
  freshUntil?: number | null
  status?: ModelCapabilityProbeRecord['status']
  omit?: ModelCapability
  probeKind?: ModelCapabilityProbeRecord['probeKind']
}): ModelCapabilityProbeRecord {
  const status = input.status ?? 'succeeded'
  const completedAt = input.completedAt ?? NOW - HOUR
  const capabilities = Object.fromEntries(
    LOOP_EXECUTOR_MANDATORY_CAPABILITIES
      .filter((capability) => capability !== input.omit)
      .map((capability) => [capability, { outcome: 'confirmed' as const, summary: `${capability} fixture passed` }])
  ) as ModelCapabilityProbeRecord['capabilities']
  if ((input.probeKind ?? 'code_execution') === 'reasoning') {
    capabilities.reasoning = { outcome: 'confirmed', summary: 'Reasoning fixture passed' }
  }
  return {
    schemaVersion: 1,
    id: input.id,
    catalogModelId: input.model.id,
    probeKind: input.probeKind ?? 'code_execution',
    probeVersion: 'catalog-probe-1',
    status,
    startedAt: completedAt - 2_000,
    completedAt: status === 'running' ? null : completedAt,
    freshUntil:
      status === 'running'
        ? null
        : status === 'succeeded'
          ? input.freshUntil === undefined
            ? completedAt + 7 * DAY
            : input.freshUntil
          : null,
    providerId: input.model.providerId,
    modelName: input.model.modelName,
    source: input.model.source,
    nodeId: input.model.nodeId,
    capabilities,
    ...(status === 'succeeded' || status === 'running'
      ? {}
      : { failureCode: `fixture_${status}`, failureMessage: `Fixture probe ${status}.` }),
    durationMs: status === 'running' ? undefined : 2_000
  }
}

const HOUR = 60 * 60_000

const providers: (ProviderCatalogSnapshot | RegistryProviderSnapshot)[] = [
  {
    id: 'chatgpt',
    label: 'Codex / OpenAI',
    available: { ok: true, checkedAt: NOW - 1_000 },
    capabilities: { reasoning: true, streaming_status: false },
    models: [
      {
        id: 'gpt-5.1-codex',
        name: 'gpt-5.1-codex',
        label: 'GPT-5.1 Codex',
        contextWindowTokens: 400_000,
        capabilities: { ...fullExecutorDeclaration, streaming_status: false }
      }
    ]
  },
  {
    providerId: 'claude',
    providerLabel: 'Claude',
    availability: true,
    capabilities: { reasoning: true, multi_file_reasoning: true },
    models: ['sonnet']
  },
  {
    providerId: 'opencode',
    providerLabel: 'OpenCode',
    availability: { ok: false, reason: 'OpenCode is not signed in.', checkedAt: NOW },
    capabilities: { ...fullExecutorDeclaration, reasoning: true },
    models: ['opencode-default']
  },
  {
    providerId: 'local',
    providerLabel: 'Ollama',
    availability: { status: 'available', checkedAt: NOW },
    capabilities: { ...fullExecutorDeclaration, reasoning: true },
    models: [
      {
        name: 'qwen3-coder:30b',
        contextWindowTokens: 131_072,
        quantization: 'Q4_K_M',
        vramRequirementMb: 20_000,
        capabilities: { streaming_status: false },
        metadata: { runtime: 'ollama', invalid_value: Number.NaN }
      }
    ]
  },
  {
    providerId: 'mystery-provider',
    providerLabel: 'Mystery',
    availability: { status: 'unknown' },
    models: [{ name: 'mystery-model', contextWindowTokens: -5, pingMs: -1 }]
  }
]

const remoteNodes: RemoteNodeCatalogSnapshot[] = [
  {
    nodeId: 'rtx-3090-pc',
    nodeName: 'RTX 3090 PC',
    availability: { ok: true, checkedAt: NOW },
    currentLoadPercent: 37,
    pingMs: 18,
    capabilities: { ...fullExecutorDeclaration, reasoning: true },
    models: [
      {
        name: 'deepseek-coder-v2:33b',
        label: 'DeepSeek Coder V2 33B',
        runtime: 'ollama',
        contextWindowTokens: 128_000,
        quantization: 'Q4_K_M',
        vramRequirementMb: 22_000
      }
    ]
  },
  {
    nodeId: 'offline-node',
    nodeName: 'Offline PC',
    availability: { ok: false, reason: 'Node has not been seen.', checkedAt: NOW },
    capabilities: fullExecutorDeclaration,
    models: [{ name: 'offline-code', runtime: 'vllm' }]
  }
]

function byModelName(models: CatalogModel[], name: string): CatalogModel {
  const model = models.find((entry) => entry.modelName === name)
  assert.ok(model, `catalog should contain ${name}`)
  return model
}

function verifyNormalizationAndIdentity(): { base: ReturnType<typeof buildModelCatalog>; models: Record<string, CatalogModel> } {
  const base = buildModelCatalog({ providers, remoteNodes, generatedAt: NOW })
  assert.equal(base.models.length, 7)
  const codex = byModelName(base.models, 'gpt-5.1-codex')
  const claude = byModelName(base.models, 'sonnet')
  const opencode = byModelName(base.models, 'opencode-default')
  const local = byModelName(base.models, 'qwen3-coder:30b')
  const remote = byModelName(base.models, 'deepseek-coder-v2:33b')
  const offline = byModelName(base.models, 'offline-code')
  const mystery = byModelName(base.models, 'mystery-model')

  assert.equal(codex.family, 'openai')
  assert.equal(claude.family, 'anthropic')
  assert.equal(opencode.family, 'opencode')
  assert.equal(local.family, 'ollama')
  assert.equal(remote.family, 'ollama')
  assert.equal(local.source, 'local')
  assert.equal(local.nodeName, 'This device')
  assert.equal(remote.source, 'remote')
  assert.equal(remote.nodeId, 'rtx-3090-pc')
  assert.equal(remote.currentLoadPercent, 37)
  assert.equal(remote.pingMs, 18)
  assert.equal(remote.quantization, 'Q4_K_M')
  assert.equal(remote.vramRequirementMb, 22_000)
  assert.equal(remote.displayLabel, 'Remote — RTX 3090 PC · DeepSeek Coder V2 33B')
  assert.equal(local.displayLabel, 'Local — This device · qwen3-coder:30b')
  assert.equal(codex.displayLabel, 'Cloud — Codex / OpenAI · GPT-5.1 Codex')
  assert.equal(offline.availability.status, 'unavailable')
  assert.equal(mystery.availability.status, 'unknown')
  assert.equal(mystery.contextWindowTokens, null, 'invalid context size is not invented or clamped')
  assert.equal(mystery.pingMs, null)
  assert.deepEqual(local.metadata, { runtime: 'ollama' }, 'invalid metadata values are omitted')

  assert.equal(inferProviderFamily('chatgpt'), 'openai')
  assert.equal(inferProviderFamily('claude'), 'anthropic')
  assert.equal(inferProviderFamily('opencode'), 'opencode')
  assert.equal(inferProviderFamily('local', 'Ollama'), 'ollama')
  assert.equal(
    stableCatalogModelId({ source: 'remote', providerId: 'remote-ollama', nodeId: 'RTX 3090 PC', modelId: 'Coder:Q4' }),
    'model:remote:remote-ollama:rtx-3090-pc:coder%3Aq4'
  )

  const reversed = buildModelCatalog({ providers: [...providers].reverse(), remoteNodes: [...remoteNodes].reverse(), generatedAt: NOW })
  assert.deepEqual(
    reversed.models.map((model) => [model.id, model.displayLabel]),
    base.models.map((model) => [model.id, model.displayLabel]),
    'catalog ids, labels, and ordering are stable across snapshot order'
  )
  const duplicate = buildModelCatalog({ providers: [providers[0], providers[0]], generatedAt: NOW })
  assert.equal(duplicate.models.length, 1)
  assert.deepEqual(duplicate.collisions, [duplicate.models[0].id])

  return { base, models: { codex, claude, opencode, local, remote, offline, mystery } }
}

function verifyCapabilityMerging(): void {
  const declaration = mergeCapabilityDeclarations(
    { file_read: true, file_edit: true, reasoning: true },
    { file_edit: false, file_create: 'unknown' }
  )
  assert.equal(declaration.file_read.support, 'supported')
  assert.equal(declaration.file_read.source, 'provider')
  assert.equal(declaration.file_edit.support, 'unsupported', 'model declaration overrides provider')
  assert.equal(declaration.file_edit.source, 'model')
  assert.equal(declaration.file_create.support, 'unknown')
  assert.equal(declaration.file_delete.support, 'unknown')

  const fixtureModel: CatalogModel = {
    id: 'model:local:fixture:this-device:model',
    providerId: 'fixture',
    providerLabel: 'Fixture',
    family: 'other',
    source: 'local',
    modelName: 'model',
    label: 'model',
    displayLabel: 'Local — This device · model',
    nodeId: 'this-device',
    nodeName: 'This device',
    availability: { status: 'available', reason: null, checkedAt: NOW },
    contextWindowTokens: null,
    quantization: null,
    vramRequirementMb: null,
    currentLoadPercent: null,
    pingMs: null,
    declaredCapabilities: declaration,
    effectiveCapabilities: declaration,
    latestProbe: null,
    latestReasoningProbe: null,
    metadata: {}
  }
  const probe = fullProbe({ id: 'merge-probe', model: fixtureModel })
  probe.capabilities.file_edit = { outcome: 'confirmed' }
  probe.capabilities.file_read = { outcome: 'rejected' }
  const merged = mergeProbeCapabilities(declaration, probe)
  assert.equal(merged.file_edit.support, 'supported')
  assert.equal(merged.file_edit.source, 'probe')
  assert.equal(merged.file_read.support, 'unsupported')
  assert.equal(merged.reasoning.source, 'provider', 'untested capability keeps declaration')
  const failed = { ...probe, status: 'failed' as const, freshUntil: null }
  assert.deepEqual(mergeProbeCapabilities(declaration, failed), declaration, 'failed probe never creates support')
}

function verifyProbeValidation(models: Record<string, CatalogModel>): void {
  const valid = fullProbe({ id: 'valid-probe', model: models.remote })
  assert.equal(validateProbeRecord(valid).ok, true)
  assert.deepEqual(probeFreshness(valid, NOW), { state: 'fresh', ageMs: HOUR })
  assert.equal(probeFreshness({ ...valid, freshUntil: NOW - 1 }, NOW).state, 'stale')
  assert.equal(probeFreshness({ ...valid, completedAt: NOW + HOUR, freshUntil: NOW + DAY }, NOW).state, 'future')
  assert.equal(validateProbeRecord({ ...valid, schemaVersion: 2 }).ok, false)
  assert.equal(validateProbeRecord({ ...valid, source: 'remote', nodeId: null }).ok, false)
  assert.equal(validateProbeRecord({ ...valid, freshUntil: (valid.completedAt ?? NOW) - 1 }).ok, false)
  assert.equal(
    validateProbeRecord({ ...valid, capabilities: { imaginary_capability: { outcome: 'confirmed' } } }).ok,
    false
  )
  assert.equal(
    validateProbeRecord({ ...valid, capabilities: { reasoning: { outcome: 'confirmed', summary: 'x'.repeat(301) } } }).ok,
    false
  )
}

function verifyEligibilityAndRouting(base: ReturnType<typeof buildModelCatalog>, models: Record<string, CatalogModel>): void {
  assert.equal(evaluatePlannerEligibility(models.claude, NOW).selectable, true, 'reasoning-only Claude is a valid planner')
  assert.equal(evaluateLoopExecutorEligibility(models.claude, NOW).code, 'probe_missing')
  assert.equal(evaluateLoopExecutorEligibility(models.local, NOW).code, 'probe_missing', 'declarations alone never imply Loop readiness')
  assert.equal(evaluateLoopExecutorEligibility(models.opencode, NOW).code, 'model_unavailable')
  assert.equal(evaluatePlannerEligibility(models.mystery, NOW).code, 'model_unavailable')

  const remoteProbe = fullProbe({ id: 'remote-fresh', model: models.remote })
  const localProbe = fullProbe({ id: 'local-fresh', model: models.local })
  const codexProbe = fullProbe({ id: 'codex-fresh', model: models.codex })
  const probed = buildModelCatalog({ providers, remoteNodes, probes: [remoteProbe, localProbe, codexProbe], generatedAt: NOW })
  const probedRemote = byModelName(probed.models, models.remote.modelName)
  const probedLocal = byModelName(probed.models, models.local.modelName)
  const probedCodex = byModelName(probed.models, models.codex.modelName)
  assert.equal(evaluateLoopExecutorEligibility(probedRemote, NOW).selectable, true)
  assert.equal(evaluateLoopExecutorEligibility(probedLocal, NOW).selectable, true)
  assert.equal(evaluateLoopExecutorEligibility(probedCodex, NOW).selectable, true)
  assert.equal(probedCodex.effectiveCapabilities.streaming_status.support, 'supported', 'fresh probe overrides static unsupported claim')

  const incomplete = fullProbe({ id: 'incomplete', model: models.remote, omit: 'streaming_status' })
  const incompleteCatalog = buildModelCatalog({ providers, remoteNodes, probes: [incomplete], generatedAt: NOW })
  const incompleteResult = evaluateLoopExecutorEligibility(byModelName(incompleteCatalog.models, models.remote.modelName), NOW)
  assert.equal(incompleteResult.code, 'mandatory_capability_missing')
  assert.deepEqual(incompleteResult.missingCapabilities, ['streaming_status'])

  const stale = fullProbe({ id: 'stale', model: models.remote, completedAt: NOW - 10 * DAY, freshUntil: NOW - DAY })
  const staleCatalog = buildModelCatalog({ providers, remoteNodes, probes: [stale], generatedAt: NOW })
  assert.equal(evaluateLoopExecutorEligibility(byModelName(staleCatalog.models, models.remote.modelName), NOW).code, 'probe_stale')

  const terminalStates: [ModelCapabilityProbeRecord['status'], string][] = [
    ['running', 'probe_running'],
    ['unavailable', 'probe_unavailable'],
    ['cancelled', 'probe_cancelled'],
    ['error', 'probe_error']
  ]
  for (const [status, expected] of terminalStates) {
    const probe = fullProbe({ id: `state-${status}`, model: models.local, status })
    const catalog = buildModelCatalog({ providers, remoteNodes, probes: [probe], generatedAt: NOW })
    assert.equal(
      evaluateLoopExecutorEligibility(byModelName(catalog.models, models.local.modelName), NOW).code,
      expected,
      `latest ${status} probe closes Loop eligibility`
    )
  }

  const oldSuccess = fullProbe({ id: 'old-success', model: models.remote, completedAt: NOW - DAY })
  const newerFailure = fullProbe({ id: 'new-failure', model: models.remote, completedAt: NOW - HOUR, status: 'failed' })
  const failedCatalog = buildModelCatalog({ providers, remoteNodes, probes: [oldSuccess, newerFailure], generatedAt: NOW })
  assert.equal(evaluateLoopExecutorEligibility(byModelName(failedCatalog.models, models.remote.modelName), NOW).code, 'probe_failed')

  const unavailableProbe = fullProbe({ id: 'unavailable', model: models.offline, status: 'unavailable' })
  const offlineCatalog = buildModelCatalog({ providers, remoteNodes, probes: [unavailableProbe], generatedAt: NOW })
  assert.equal(evaluateLoopExecutorEligibility(byModelName(offlineCatalog.models, models.offline.modelName), NOW).code, 'model_unavailable')

  const reasoningOnly = fullProbe({ id: 'reasoning-only', model: models.mystery, probeKind: 'reasoning' })
  const reasoningCatalog = buildModelCatalog({ providers, remoteNodes, probes: [reasoningOnly], generatedAt: NOW })
  const reasoningMystery = byModelName(reasoningCatalog.models, models.mystery.modelName)
  assert.equal(reasoningMystery.effectiveCapabilities.reasoning.support, 'supported')
  assert.equal(evaluatePlannerEligibility(reasoningMystery, NOW).code, 'model_unavailable', 'probe cannot override unknown availability')
  assert.equal(evaluateLoopExecutorEligibility(reasoningMystery, NOW).code, 'model_unavailable')

  const profile = {
    schemaVersion: 1,
    id: 'recommended-default',
    name: 'Recommended default',
    plannerModelId: models.claude.id,
    loopExecutorModelId: probedRemote.id,
    debuggerModelId: probedCodex.id,
    fallbackLoopExecutorModelIds: [probedLocal.id],
    createdAt: NOW,
    updatedAt: NOW
  }
  const validProfile = validateRoutingProfile(profile, probed, NOW)
  assert.equal(validProfile.ok, true)
  const duplicateProfile = validateRoutingProfile(
    { ...profile, fallbackLoopExecutorModelIds: [probedRemote.id, probedRemote.id] },
    probed,
    NOW
  )
  assert.equal(duplicateProfile.ok, false)
  if (!duplicateProfile.ok) assert.ok(duplicateProfile.issues.some((issue) => issue.code === 'duplicate_fallback'))
  const missingProfile = validateRoutingProfile({ ...profile, loopExecutorModelId: 'model:missing' }, probed, NOW)
  assert.equal(missingProfile.ok, false)
  if (!missingProfile.ok) assert.ok(missingProfile.issues.some((issue) => issue.code === 'model_not_found'))
  const unprobedProfile = validateRoutingProfile({ ...profile, loopExecutorModelId: models.local.id }, base, NOW)
  assert.equal(unprobedProfile.ok, false)
  if (!unprobedProfile.ok) assert.ok(unprobedProfile.issues.some((issue) => issue.code === 'executor_ineligible'))
}

const { base, models } = verifyNormalizationAndIdentity()
verifyCapabilityMerging()
verifyProbeValidation(models)
verifyEligibilityAndRouting(base, models)
assert.equal(MODEL_CAPABILITIES.length, 13)
console.log('verify-model-catalog: ok')

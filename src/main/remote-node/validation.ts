import {
  REMOTE_NODE_PROTOCOL_VERSION,
  REMOTE_NODE_SAFETY_POLICY,
  type AdapterGenerationChunk,
  type GenerationMessage,
  type RemoteGenerationRequest,
  type RemoteGpuDevice,
  type RemoteHardwareSnapshot,
  type RemoteModelCapabilities,
  type RemoteNodeRequest,
  type RuntimeModelDescription
} from './types'

export interface ValidationResult<T> {
  ok: boolean
  value?: T
  error?: string
}

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/
const MODEL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,255}$/
const FORBIDDEN_GENERATION_KEYS = new Set([
  'workspacePath',
  'workingDirectory',
  'filesystem',
  'files',
  'commands',
  'shell',
  'git',
  'tools',
  'toolChoice',
  'execute'
])
const ENVELOPE_KEYS = new Set(['protocolVersion', 'requestId', 'kind', 'bearerToken', 'body'])
const GENERATION_KEYS = new Set(['modelKey', 'messages', 'maxOutputTokens', 'temperature', 'safety'])
const MESSAGE_KEYS = new Set(['role', 'content'])
const SAFETY_KEYS = new Set(['inferenceOnly', 'codeToolsLocation', 'nodeFilesystemAccess', 'nodeCommandExecution', 'nodeGitAccess'])
const CATALOG_KEYS = new Set(['refresh'])
const CANCEL_KEYS = new Set(['generationId'])

function hasOnlyKeys(input: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(input).every((key) => allowed.has(key))
}

function finiteInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

function optionalBoundedString(value: unknown, max: number): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= max && !/[\0\r\n]/.test(value))
}

function validCapability(value: unknown): value is 'verified' | 'reported' | 'unknown' {
  return value === 'verified' || value === 'reported' || value === 'unknown'
}

export function validateModelCapabilities(value: unknown): ValidationResult<RemoteModelCapabilities> {
  if (!value || typeof value !== 'object') return { ok: false, error: 'model capabilities must be an object' }
  const input = value as Record<string, unknown>
  if (
    input.textGeneration !== true ||
    typeof input.streaming !== 'boolean' ||
    typeof input.cancellation !== 'boolean' ||
    !validCapability(input.toolUse) ||
    !validCapability(input.codeEditing) ||
    !validCapability(input.multiFileReasoning) ||
    !validCapability(input.commandPlanning)
  ) {
    return { ok: false, error: 'model capability fields are invalid or incomplete' }
  }
  return {
    ok: true,
    value: {
      textGeneration: true,
      streaming: input.streaming,
      cancellation: input.cancellation,
      toolUse: input.toolUse,
      codeEditing: input.codeEditing,
      multiFileReasoning: input.multiFileReasoning,
      commandPlanning: input.commandPlanning
    }
  }
}

function cleanGpuDevice(device: RemoteGpuDevice): RemoteGpuDevice {
  return {
    id: device.id,
    name: device.name,
    ...(device.utilizationPercent !== undefined ? { utilizationPercent: device.utilizationPercent } : {}),
    ...(device.memoryUsedBytes !== undefined ? { memoryUsedBytes: device.memoryUsedBytes } : {}),
    ...(device.memoryTotalBytes !== undefined ? { memoryTotalBytes: device.memoryTotalBytes } : {}),
    ...(device.temperatureC !== undefined ? { temperatureC: device.temperatureC } : {}),
    ...(device.powerWatts !== undefined ? { powerWatts: device.powerWatts } : {}),
    ...(device.processName !== undefined ? { processName: device.processName } : {}),
    ...(device.activeModel !== undefined ? { activeModel: device.activeModel } : {})
  }
}

function validateGpuDevice(device: unknown): device is RemoteGpuDevice {
  if (!device || typeof device !== 'object') return false
  const input = device as Record<string, unknown>
  if (typeof input.id !== 'string' || !ID_PATTERN.test(input.id)) return false
  if (typeof input.name !== 'string' || input.name.trim().length === 0 || input.name.length > 200) return false
  if (input.utilizationPercent !== undefined && !finiteInRange(input.utilizationPercent, 0, 100)) return false
  if (input.memoryUsedBytes !== undefined && !finiteInRange(input.memoryUsedBytes, 0, Number.MAX_SAFE_INTEGER)) return false
  if (input.memoryTotalBytes !== undefined && !finiteInRange(input.memoryTotalBytes, 1, Number.MAX_SAFE_INTEGER)) return false
  if (
    typeof input.memoryUsedBytes === 'number' &&
    typeof input.memoryTotalBytes === 'number' &&
    input.memoryUsedBytes > input.memoryTotalBytes
  ) {
    return false
  }
  if (input.temperatureC !== undefined && !finiteInRange(input.temperatureC, -100, 250)) return false
  if (input.powerWatts !== undefined && !finiteInRange(input.powerWatts, 0, 10_000)) return false
  if (!optionalBoundedString(input.processName, 200) || !optionalBoundedString(input.activeModel, 300)) return false
  return true
}

export function validateHardwareSnapshot(value: unknown): ValidationResult<RemoteHardwareSnapshot> {
  if (!value || typeof value !== 'object') return { ok: false, error: 'hardware snapshot must be an object' }
  const input = value as Record<string, unknown>
  const cpu = input.cpu as Record<string, unknown> | undefined
  const memory = input.memory as Record<string, unknown> | undefined
  const gpu = input.gpu as Record<string, unknown> | undefined
  if (!finiteInRange(input.observedAt, 0, Number.MAX_SAFE_INTEGER)) return { ok: false, error: 'invalid observedAt' }
  if (typeof input.platform !== 'string' || input.platform.length === 0 || input.platform.length > 40) {
    return { ok: false, error: 'invalid platform' }
  }
  if (typeof input.architecture !== 'string' || input.architecture.length === 0 || input.architecture.length > 40) {
    return { ok: false, error: 'invalid architecture' }
  }
  if (!cpu || !finiteInRange(cpu.logicalCores, 1, 4_096) || !optionalBoundedString(cpu.model, 300)) {
    return { ok: false, error: 'invalid CPU observation' }
  }
  if (!memory) return { ok: false, error: 'memory observation is required' }
  if (memory.totalBytes !== undefined && !finiteInRange(memory.totalBytes, 1, Number.MAX_SAFE_INTEGER)) {
    return { ok: false, error: 'invalid total memory' }
  }
  if (memory.freeBytes !== undefined && !finiteInRange(memory.freeBytes, 0, Number.MAX_SAFE_INTEGER)) {
    return { ok: false, error: 'invalid free memory' }
  }
  if (
    typeof memory.totalBytes === 'number' &&
    typeof memory.freeBytes === 'number' &&
    memory.freeBytes > memory.totalBytes
  ) {
    return { ok: false, error: 'free memory exceeds total memory' }
  }
  if (!gpu || !Array.isArray(gpu.devices)) return { ok: false, error: 'GPU observation is required' }
  if (gpu.status === 'unavailable') {
    if (gpu.devices.length !== 0 || typeof gpu.reason !== 'string' || !gpu.reason.trim() || gpu.reason.length > 500) {
      return { ok: false, error: 'unavailable GPU status requires an empty device list and honest reason' }
    }
  } else if (gpu.status === 'observed') {
    if (gpu.devices.length === 0 || gpu.devices.length > 32 || !gpu.devices.every(validateGpuDevice)) {
      return { ok: false, error: 'observed GPU status requires valid observed devices' }
    }
  } else {
    return { ok: false, error: 'invalid GPU status' }
  }
  const gpuSnapshot =
    gpu.status === 'observed'
      ? { status: 'observed' as const, devices: (gpu.devices as RemoteGpuDevice[]).map(cleanGpuDevice) }
      : { status: 'unavailable' as const, devices: [] as [], reason: gpu.reason as string }
  return {
    ok: true,
    value: {
      observedAt: input.observedAt as number,
      platform: input.platform as string,
      architecture: input.architecture as string,
      cpu: {
        logicalCores: cpu.logicalCores as number,
        ...(cpu.model !== undefined ? { model: cpu.model as string } : {})
      },
      memory: {
        ...(memory.totalBytes !== undefined ? { totalBytes: memory.totalBytes as number } : {}),
        ...(memory.freeBytes !== undefined ? { freeBytes: memory.freeBytes as number } : {})
      },
      gpu: gpuSnapshot
    }
  }
}

export function unavailableHardware(
  platform: NodeJS.Platform | string,
  architecture: string,
  logicalCores: number,
  reason: string,
  now = Date.now()
): RemoteHardwareSnapshot {
  return {
    observedAt: now,
    platform: String(platform).slice(0, 40) || 'unknown',
    architecture: String(architecture).slice(0, 40) || 'unknown',
    cpu: { logicalCores: Math.min(Math.max(Math.trunc(logicalCores) || 1, 1), 4_096) },
    memory: {},
    gpu: { status: 'unavailable', devices: [], reason: reason.trim().slice(0, 500) || 'Hardware telemetry unavailable.' }
  }
}

export function validateRuntimeModel(value: unknown): ValidationResult<RuntimeModelDescription> {
  if (!value || typeof value !== 'object') return { ok: false, error: 'runtime model must be an object' }
  const input = value as Record<string, unknown>
  if (typeof input.id !== 'string' || !MODEL_ID_PATTERN.test(input.id)) return { ok: false, error: 'invalid model id' }
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 300) {
    return { ok: false, error: 'invalid model name' }
  }
  if (input.available !== undefined && typeof input.available !== 'boolean') return { ok: false, error: 'invalid availability' }
  if (!optionalBoundedString(input.unavailableReason, 500)) return { ok: false, error: 'invalid availability reason' }
  if (input.contextLength !== undefined && !finiteInRange(input.contextLength, 1, 100_000_000)) {
    return { ok: false, error: 'invalid context length' }
  }
  if (!optionalBoundedString(input.quantization, 80)) return { ok: false, error: 'invalid quantization' }
  if (input.requiredVramBytes !== undefined && !finiteInRange(input.requiredVramBytes, 0, Number.MAX_SAFE_INTEGER)) {
    return { ok: false, error: 'invalid VRAM requirement' }
  }
  const capabilities = validateModelCapabilities(input.capabilities)
  if (!capabilities.ok) return { ok: false, error: capabilities.error }
  return {
    ok: true,
    value: {
      id: input.id,
      name: input.name,
      ...(input.available !== undefined ? { available: input.available } : {}),
      ...(input.unavailableReason !== undefined ? { unavailableReason: input.unavailableReason } : {}),
      ...(input.contextLength !== undefined ? { contextLength: input.contextLength } : {}),
      ...(input.quantization !== undefined ? { quantization: input.quantization } : {}),
      ...(input.requiredVramBytes !== undefined ? { requiredVramBytes: input.requiredVramBytes } : {}),
      capabilities: capabilities.value!
    }
  }
}

function hasForbiddenGenerationKey(value: unknown, depth = 0): boolean {
  if (depth > 8 || !value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some((item) => hasForbiddenGenerationKey(item, depth + 1))
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_GENERATION_KEYS.has(key)) return true
    if (key !== 'content' && hasForbiddenGenerationKey(child, depth + 1)) return true
  }
  return false
}

export function validateGenerationRequest(value: unknown, maxPromptChars = 200_000): ValidationResult<RemoteGenerationRequest> {
  if (!value || typeof value !== 'object') return { ok: false, error: 'generation request must be an object' }
  if (hasForbiddenGenerationKey(value)) {
    return { ok: false, error: 'remote generation is inference-only; filesystem, command, git, and tool fields are forbidden' }
  }
  const input = value as Record<string, unknown>
  if (!hasOnlyKeys(input, GENERATION_KEYS)) {
    return { ok: false, error: 'generation request contains unsupported fields' }
  }
  if (typeof input.modelKey !== 'string' || !ID_PATTERN.test(input.modelKey)) return { ok: false, error: 'invalid model key' }
  if (!Array.isArray(input.messages) || input.messages.length === 0 || input.messages.length > 64) {
    return { ok: false, error: 'messages must contain 1-64 entries' }
  }
  let promptChars = 0
  const messages: GenerationMessage[] = []
  for (const message of input.messages) {
    if (!message || typeof message !== 'object') return { ok: false, error: 'invalid message' }
    const item = message as Record<string, unknown>
    if (!hasOnlyKeys(item, MESSAGE_KEYS)) return { ok: false, error: 'message contains unsupported fields' }
    if (item.role !== 'system' && item.role !== 'user' && item.role !== 'assistant') return { ok: false, error: 'invalid message role' }
    if (typeof item.content !== 'string' || item.content.length === 0) return { ok: false, error: 'message content is required' }
    promptChars += item.content.length
    messages.push({ role: item.role, content: item.content })
  }
  if (promptChars > maxPromptChars) return { ok: false, error: 'prompt exceeds the remote-node character cap' }
  if (input.maxOutputTokens !== undefined && !finiteInRange(input.maxOutputTokens, 1, 1_000_000)) {
    return { ok: false, error: 'invalid maxOutputTokens' }
  }
  if (input.temperature !== undefined && !finiteInRange(input.temperature, 0, 2)) return { ok: false, error: 'invalid temperature' }
  const safety = input.safety as Record<string, unknown> | undefined
  if (
    !safety ||
    !hasOnlyKeys(safety, SAFETY_KEYS) ||
    safety.inferenceOnly !== REMOTE_NODE_SAFETY_POLICY.inferenceOnly ||
    safety.codeToolsLocation !== REMOTE_NODE_SAFETY_POLICY.codeToolsLocation ||
    safety.nodeFilesystemAccess !== false ||
    safety.nodeCommandExecution !== false ||
    safety.nodeGitAccess !== false
  ) {
    return { ok: false, error: 'remote generation must preserve the client-side code-tools safety policy' }
  }
  return {
    ok: true,
    value: {
      modelKey: input.modelKey,
      messages,
      ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens as number } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature as number } : {}),
      safety: { ...REMOTE_NODE_SAFETY_POLICY }
    }
  }
}

export function validateAdapterChunk(value: unknown, maxChunkChars: number): ValidationResult<AdapterGenerationChunk> {
  if (!value || typeof value !== 'object') return { ok: false, error: 'invalid stream chunk' }
  const input = value as Record<string, unknown>
  if (input.type === 'delta') {
    if (typeof input.text !== 'string' || input.text.length === 0 || input.text.length > maxChunkChars) {
      return { ok: false, error: 'invalid or oversized delta chunk' }
    }
    return { ok: true, value: { type: 'delta', text: input.text } }
  }
  if (input.type === 'usage') {
    for (const key of ['promptTokens', 'completionTokens', 'cachedTokens'] as const) {
      if (input[key] !== undefined && !finiteInRange(input[key], 0, Number.MAX_SAFE_INTEGER)) {
        return { ok: false, error: `invalid ${key}` }
      }
    }
    return { ok: true, value: input as unknown as AdapterGenerationChunk }
  }
  return { ok: false, error: 'unsupported adapter stream chunk type' }
}

export function validateRequestEnvelope(value: unknown, maxBodyBytes: number): ValidationResult<RemoteNodeRequest> {
  if (!value || typeof value !== 'object') return { ok: false, error: 'request envelope must be an object' }
  const input = value as Record<string, unknown>
  if (!hasOnlyKeys(input, ENVELOPE_KEYS)) {
    return { ok: false, error: 'request envelope contains unsupported fields' }
  }
  if (input.protocolVersion !== REMOTE_NODE_PROTOCOL_VERSION) return { ok: false, error: 'unsupported protocol version' }
  if (typeof input.requestId !== 'string' || !ID_PATTERN.test(input.requestId)) return { ok: false, error: 'invalid request id' }
  if (input.kind !== 'health' && input.kind !== 'catalog' && input.kind !== 'generate' && input.kind !== 'cancel') {
    return { ok: false, error: 'unsupported request kind' }
  }
  if (typeof input.bearerToken !== 'string' || input.bearerToken.length < 20 || input.bearerToken.length > 500) {
    return { ok: false, error: 'missing or invalid bearer token' }
  }
  if (!input.body || typeof input.body !== 'object' || Array.isArray(input.body)) return { ok: false, error: 'request body must be an object' }
  let bodyBytes = 0
  try {
    bodyBytes = Buffer.byteLength(JSON.stringify(input.body), 'utf8')
  } catch {
    return { ok: false, error: 'request body is not JSON serializable' }
  }
  if (bodyBytes > maxBodyBytes) return { ok: false, error: 'request body exceeds the remote-node size cap' }
  const body = input.body as Record<string, unknown>
  if (input.kind === 'health' && Object.keys(body).length > 0) return { ok: false, error: 'health request body must be empty' }
  if (input.kind === 'catalog') {
    if (!hasOnlyKeys(body, CATALOG_KEYS) || (body.refresh !== undefined && typeof body.refresh !== 'boolean')) {
      return { ok: false, error: 'invalid catalog request body' }
    }
  }
  if (input.kind === 'generate') {
    const generation = validateGenerationRequest(input.body)
    if (!generation.ok) return { ok: false, error: generation.error }
  }
  if (input.kind === 'cancel') {
    if (!hasOnlyKeys(body, CANCEL_KEYS)) return { ok: false, error: 'invalid cancel request body' }
    const generationId = body.generationId
    if (typeof generationId !== 'string' || !ID_PATTERN.test(generationId)) return { ok: false, error: 'invalid generation id' }
  }
  return { ok: true, value: input as unknown as RemoteNodeRequest }
}

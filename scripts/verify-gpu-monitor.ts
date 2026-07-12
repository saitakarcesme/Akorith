import assert from 'node:assert/strict'
import {
  FixedGpuCommandError,
  GpuMonitor,
  NVIDIA_SMI_ARGS,
  NVIDIA_SMI_EXECUTABLE,
  NVIDIA_SMI_PROCESS_ARGS,
  NvidiaSmiGpuSource,
  RemoteNodeGpuSource,
  normalizeGpuDevice,
  normalizeMetric,
  parseNvidiaSmiOutput,
  parseNvidiaProcessOutput,
  validateGpuObservation,
  type FixedGpuCommandRequest,
  type FixedGpuCommandRunner,
  type GpuMonitorError,
  type GpuMonitorTimer,
  type GpuSampleSource,
  type GpuTelemetrySink
} from '../src/main/gpu-monitor/index.ts'
import type { GpuDetailSampleInput } from '../src/main/telemetry/types.ts'

let assertions = 0
function check(condition: unknown, message: string): asserts condition {
  assertions += 1
  assert.ok(condition, message)
}
function equal<T>(actual: T, expected: T, message: string): void {
  assertions += 1
  assert.equal(actual, expected, message)
}
function deepEqual(actual: unknown, expected: unknown, message: string): void {
  assertions += 1
  assert.deepEqual(actual, expected, message)
}

async function main(): Promise<void> {
equal(normalizeMetric('N/A', 0, 100), undefined, 'unsupported metrics stay absent')
equal(normalizeMetric(' 42.5 ', 0, 100), 42.5, 'numeric metric strings normalize without rounding')
equal(normalizeMetric('101', 0, 100), undefined, 'out-of-range utilization is not clamped')
check(
  !normalizeGpuDevice({ id: 'gpu-0', name: 'Fixture', memoryUsedMb: 9000, memoryTotalMb: 8000 }).ok,
  'impossible memory relationships are rejected'
)
check(
  !validateGpuObservation({
    status: 'unavailable',
    observedAt: 1,
    devices: [{ id: 'fake', name: 'Fake', utilizationPercent: 99 }],
    reason: 'not observed',
    warnings: []
  }).ok,
  'unavailable observations cannot smuggle measurements'
)

const parsedCsv = parseNvidiaSmiOutput(
  '0, GPU-abc, "RTX, Fixture", 41, 2048, 24576, 62, 185.5\n' +
    '1, GPU-def, No Metrics GPU, N/A, [N/A], [Not Supported], N/A, N/A\n' +
    'malformed row\n'
)
equal(parsedCsv.devices.length, 1, 'only valid measured NVIDIA rows are retained')
equal(parsedCsv.devices[0]?.name, 'RTX, Fixture', 'quoted CSV device names are parsed safely')
equal(parsedCsv.devices[0]?.powerWatts, 185.5, 'NVIDIA power is normalized')
equal(parsedCsv.warnings.length, 2, 'invalid NVIDIA rows produce bounded warnings')
const parsedProcesses = parseNvidiaProcessOutput('GPU-abc, ollama.exe, 12288\nGPU-abc, helper.exe, 64\n')
equal(parsedProcesses.byGpuUuid.get('GPU-abc'), 'ollama.exe', 'largest measured GPU process is attributed')

const capturedCommands: FixedGpuCommandRequest[] = []
const fixtureRunner: FixedGpuCommandRunner = {
  async run(request: FixedGpuCommandRequest) {
    capturedCommands.push(request)
    if (request.args === NVIDIA_SMI_PROCESS_ARGS) return { stdout: 'GPU-123, ollama.exe, 12000\n', stderr: '' }
    return { stdout: '0, GPU-123, RTX 3090, 73, 12000, 24576, 68, 282.4\n', stderr: '' }
  }
}
const nvidia = new NvidiaSmiGpuSource({ runner: fixtureRunner, platform: () => 'win32', now: () => 50_000 })
const nvidiaObservation = await nvidia.sample(new AbortController().signal)
equal(nvidiaObservation.status, 'observed', 'supported NVIDIA fixture is observed')
check(capturedCommands.length === 2, 'NVIDIA source invoked fixed device and process queries')
equal(capturedCommands[0]?.executable, NVIDIA_SMI_EXECUTABLE, 'NVIDIA executable is fixed')
deepEqual(capturedCommands[0]?.args, NVIDIA_SMI_ARGS, 'NVIDIA device arguments are fixed')
deepEqual(capturedCommands[1]?.args, NVIDIA_SMI_PROCESS_ARGS, 'NVIDIA process arguments are fixed')
equal(capturedCommands[0]?.maxOutputBytes, 128 * 1024, 'NVIDIA command output is bounded')
if (nvidiaObservation.status === 'observed') equal(nvidiaObservation.devices[0]?.processName, 'ollama.exe', 'local process attribution reaches observation')

let unsupportedInvocations = 0
const unsupported = new NvidiaSmiGpuSource({
  runner: {
    async run() {
      unsupportedInvocations += 1
      return { stdout: '', stderr: '' }
    }
  },
  platform: () => 'darwin',
  now: () => 60_000
})
const unsupportedObservation = await unsupported.sample(new AbortController().signal)
equal(unsupportedObservation.status, 'unsupported', 'unsupported platforms are explicit')
equal(unsupportedInvocations, 0, 'unsupported platforms do not spawn nvidia-smi')

const missing = new NvidiaSmiGpuSource({
  runner: {
    async run() {
      throw new FixedGpuCommandError('missing', 'ENOENT')
    }
  },
  platform: () => 'linux',
  now: () => 70_000
})
const missingObservation = await missing.sample(new AbortController().signal)
equal(missingObservation.status, 'unavailable', 'missing NVIDIA utility is honest unavailable state')
check(missingObservation.status !== 'observed' && /not found/i.test(missingObservation.reason), 'missing utility has an actionable reason')

const remoteHardware = {
  observedAt: 80_000,
  platform: 'win32',
  architecture: 'x64',
  cpu: { logicalCores: 24, model: 'Fixture CPU' },
  memory: { totalBytes: 64 * 1024 ** 3, freeBytes: 32 * 1024 ** 3 },
  gpu: {
    status: 'observed' as const,
    devices: [
      {
        id: 'gpu-remote-0',
        name: 'Remote RTX 3090',
        utilizationPercent: 64,
        memoryUsedBytes: 12 * 1024 ** 3,
        memoryTotalBytes: 24 * 1024 ** 3,
        temperatureC: 66,
        powerWatts: 275,
        processName: 'ollama',
        activeModel: 'qwen-code'
      }
    ]
  }
}
const remote = new RemoteNodeGpuSource({
  nodeId: 'workstation-3090',
  async fetchGpuSnapshot() {
    return { health: { hardware: remoteHardware } }
  }
})
const remoteObservation = await remote.sample(new AbortController().signal)
equal(remoteObservation.status, 'observed', 'remote-node health response adapts to GPU observation')
if (remoteObservation.status === 'observed') {
  equal(remoteObservation.devices[0]?.memoryUsedMb, 12 * 1024, 'remote bytes normalize to telemetry MiB')
  equal(remoteObservation.devices[0]?.activeModel, 'qwen-code', 'remote active model evidence is preserved')
}

const remoteUnavailable = new RemoteNodeGpuSource({
  nodeId: 'remote-no-gpu',
  async fetchGpuSnapshot() {
    return {
      ...remoteHardware,
      gpu: { status: 'unavailable', devices: [], reason: 'Driver counters are disabled.' }
    }
  }
})
const remoteUnavailableObservation = await remoteUnavailable.sample(new AbortController().signal)
equal(remoteUnavailableObservation.status, 'unavailable', 'remote unavailable telemetry remains unavailable')
check(
  remoteUnavailableObservation.status !== 'observed' && /driver counters/i.test(remoteUnavailableObservation.reason),
  'remote unavailable reason is retained'
)

const disconnected = new RemoteNodeGpuSource({
  nodeId: 'offline-node',
  async fetchGpuSnapshot() {
    throw new Error('connection refused')
  }
})
const disconnectedObservation = await disconnected.sample(new AbortController().signal)
equal(disconnectedObservation.status, 'disconnected', 'remote transport failures remain distinct')
check(disconnectedObservation.status !== 'observed' && disconnectedObservation.devices.length === 0, 'disconnected state has no fake devices')

const invalidRemote = new RemoteNodeGpuSource({
  nodeId: 'invalid-telemetry-node',
  async fetchGpuSnapshot() {
    return { ...remoteHardware, gpu: { status: 'observed', devices: [{ id: 'gpu-bad', name: 'Bad', utilizationPercent: 900 }] } }
  }
})
const invalidRemoteObservation = await invalidRemote.sample(new AbortController().signal)
equal(invalidRemoteObservation.status, 'unavailable', 'invalid remote measurements degrade to unavailable')
check(
  invalidRemoteObservation.status !== 'observed' && invalidRemoteObservation.devices.length === 0,
  'invalid remote measurements are never persisted'
)

let clock = 100_000
const timer: GpuMonitorTimer = {
  now: () => clock,
  setTimeout(callback, delayMs) {
    return globalThis.setTimeout(callback, delayMs)
  },
  clearTimeout(handle) {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>)
  }
}
let sourceCalls = 0
const sequenceSource: GpuSampleSource = {
  id: 'remote:fixture:gpu',
  nodeId: 'fixture-node',
  location: 'remote',
  async sample() {
    sourceCalls += 1
    if (sourceCalls <= 2) {
      return { status: 'disconnected', observedAt: clock, devices: [], reason: 'fixture offline', warnings: [] }
    }
    return {
      status: 'observed',
      observedAt: clock,
      devices: [{ id: 'gpu-0', name: 'Fixture GPU', utilizationPercent: 52, memoryUsedMb: 512, memoryTotalMb: 1024 }],
      warnings: []
    }
  }
}
const samples: GpuDetailSampleInput[] = []
const maintenance: number[] = []
const sink: GpuTelemetrySink = {
  writeSample(sample) {
    samples.push({ ...sample })
  },
  maintain(now) {
    maintenance.push(now)
    return { samplesRolledUp: 0, detailSamplesDeleted: 0, rollupsDeleted: 0, aggregateEventsAdded: 0 }
  }
}
const monitor = new GpuMonitor({
  sources: [sequenceSource],
  sink,
  timer,
  policy: { initialBackoffMs: 1_000, maxBackoffMs: 8_000, backoffMultiplier: 2 }
})
const firstPoll = await monitor.pollOnce()
equal(firstPoll[0]?.state.nextPollAt, 101_000, 'first transport failure uses initial backoff')
clock = 100_999
const skippedPoll = await monitor.pollOnce()
equal(skippedPoll[0]?.skipped, true, 'polling respects per-source backoff')
equal(sourceCalls, 1, 'backoff prevents source calls before eligibility')
clock = 101_000
const secondPoll = await monitor.pollOnce()
equal(secondPoll[0]?.state.nextPollAt, 103_000, 'consecutive failure increases backoff')
clock = 103_000
const recoveredPoll = await monitor.pollOnce()
equal(recoveredPoll[0]?.samplesWritten, 1, 'recovered observation feeds the telemetry detail sink')
equal(samples[0]?.nodeId, 'fixture-node', 'telemetry sink receives the source node identity')
equal(samples[0]?.utilizationPercent, 52, 'telemetry sink receives measured utilization')
equal(recoveredPoll[0]?.state.consecutiveFailures, 0, 'successful observation resets backoff')
const duplicatePoll = await monitor.pollOnce({ force: true })
equal(duplicatePoll[0]?.duplicateSamplesSkipped, 1, 'same remote timestamp is not written twice')
equal(samples.length, 1, 'duplicate observation does not inflate telemetry')
await monitor.maintainNow()
deepEqual(maintenance, [103_000], 'monitor exposes and feeds retention maintenance')

let timeoutSignalAborted = false
const immediateTimer: GpuMonitorTimer = {
  now: () => 200_000,
  setTimeout(callback) {
    const handle = { cancelled: false }
    queueMicrotask(() => {
      if (!handle.cancelled) callback()
    })
    return handle
  },
  clearTimeout(handle) {
    ;(handle as { cancelled: boolean }).cancelled = true
  }
}
const timeoutErrors: GpuMonitorError[] = []
const timeoutSource: GpuSampleSource = {
  id: 'local:timeout-gpu',
  nodeId: 'local',
  location: 'local',
  async sample(signal) {
    timeoutSignalAborted = signal.aborted
    return new Promise(() => undefined)
  }
}
const timeoutMonitor = new GpuMonitor({
  sources: [timeoutSource],
  sink: { writeSample() {} },
  timer: immediateTimer,
  policy: { sourceTimeoutMs: 100 },
  onError: (error) => timeoutErrors.push(error)
})
const timeoutPoll = await timeoutMonitor.pollOnce()
equal(timeoutPoll[0]?.state.lastObservation?.status, 'unavailable', 'source timeout becomes honest unavailable state')
equal(timeoutSignalAborted, true, 'source timeout propagates cancellation')
check(timeoutErrors.some((error) => error.phase === 'source' && /timed out/i.test(error.message)), 'timeout is reported diagnostically')

let lifecycleStarted!: () => void
const lifecycleReady = new Promise<void>((resolve) => {
  lifecycleStarted = resolve
})
let lifecycleAborted = false
const lifecycleSource: GpuSampleSource = {
  id: 'remote:lifecycle:gpu',
  nodeId: 'lifecycle-node',
  location: 'remote',
  async sample(signal) {
    lifecycleStarted()
    return new Promise((_resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => {
          lifecycleAborted = true
          const error = new Error('cancelled')
          error.name = 'AbortError'
          reject(error)
        },
        { once: true }
      )
    })
  }
}
const lifecycleMonitor = new GpuMonitor({ sources: [lifecycleSource], sink: { writeSample() {} } })
lifecycleMonitor.start()
await lifecycleReady
equal(lifecycleMonitor.getSnapshot().running, true, 'monitor lifecycle reports running state')
await lifecycleMonitor.stop()
equal(lifecycleAborted, true, 'stopping monitor cancels in-flight remote sampling')
equal(lifecycleMonitor.getSnapshot().running, false, 'monitor lifecycle stops cleanly')

console.log(`verify-gpu-monitor: ok (${assertions} assertions)`)
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

import { execFile } from 'node:child_process'
import { platform } from 'node:os'
import { normalizeGpuDevice } from './normalization'
import type { GpuObservation, GpuSampleSource, NormalizedGpuDevice } from './types'

export const NVIDIA_SMI_EXECUTABLE = 'nvidia-smi' as const
export const NVIDIA_SMI_ARGS = Object.freeze([
  '--query-gpu=index,uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw',
  '--format=csv,noheader,nounits'
] as const)
export const NVIDIA_SMI_PROCESS_ARGS = Object.freeze([
  '--query-compute-apps=gpu_uuid,process_name,used_gpu_memory',
  '--format=csv,noheader,nounits'
] as const)

const MAX_NVIDIA_OUTPUT_BYTES = 128 * 1024
const DEFAULT_TIMEOUT_MS = 3_000

export interface FixedGpuCommandRequest {
  executable: typeof NVIDIA_SMI_EXECUTABLE
  args: readonly string[]
  timeoutMs: number
  maxOutputBytes: number
  signal: AbortSignal
}

export interface FixedGpuCommandResult {
  stdout: string
  stderr: string
}

export interface FixedGpuCommandRunner {
  run(request: FixedGpuCommandRequest): Promise<FixedGpuCommandResult>
}

export class FixedGpuCommandError extends Error {
  readonly code?: string

  constructor(message: string, code?: string) {
    super(message)
    this.name = 'FixedGpuCommandError'
    this.code = code
  }
}

function abortError(reason?: unknown): Error {
  const error = new Error(typeof reason === 'string' && reason ? reason : 'GPU command was cancelled.')
  error.name = 'AbortError'
  return error
}

export const nodeExecFileGpuRunner: FixedGpuCommandRunner = Object.freeze({
  run(request: FixedGpuCommandRequest): Promise<FixedGpuCommandResult> {
    if (request.signal.aborted) return Promise.reject(abortError(request.signal.reason))
    return new Promise((resolve, reject) => {
      try {
        execFile(
          request.executable,
          [...request.args],
          {
            encoding: 'utf8',
            maxBuffer: request.maxOutputBytes,
            timeout: request.timeoutMs,
            windowsHide: true,
            signal: request.signal,
            shell: false
          },
          (error, stdout, stderr) => {
            if (error) {
              if (request.signal.aborted || error.name === 'AbortError') {
                reject(abortError(request.signal.reason))
                return
              }
              const code = typeof (error as NodeJS.ErrnoException).code === 'string' ? (error as NodeJS.ErrnoException).code : undefined
              reject(new FixedGpuCommandError('nvidia-smi could not be queried.', code))
              return
            }
            resolve({ stdout: stdout ?? '', stderr: stderr ?? '' })
          }
        )
      } catch (error) {
        reject(error)
      }
    })
  }
})

function parseCsvLine(line: string): string[] | null {
  const fields: string[] = []
  let value = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"'
        index += 1
      } else {
        quoted = !quoted
      }
    } else if (character === ',' && !quoted) {
      fields.push(value.trim())
      value = ''
    } else {
      value += character
    }
  }
  if (quoted) return null
  fields.push(value.trim())
  return fields
}

export interface ParsedNvidiaSmiOutput {
  devices: NormalizedGpuDevice[]
  warnings: string[]
}

export function parseNvidiaSmiOutput(stdout: string): ParsedNvidiaSmiOutput {
  const devices: ParsedNvidiaSmiOutput['devices'] = []
  const warnings: string[] = []
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim())
  for (let row = 0; row < lines.length; row += 1) {
    const fields = parseCsvLine(lines[row]!)
    if (!fields || fields.length !== 8 || !/^\d+$/.test(fields[0] ?? '')) {
      warnings.push(`Ignored malformed nvidia-smi row ${row + 1}.`)
      continue
    }
    const index = fields[0]!
    const uuid = fields[1]?.trim()
    const id = uuid && !/^(?:n\/a|\[n\/a\]|not supported|\[not supported\])$/i.test(uuid) ? uuid : `gpu-${index}`
    const normalized = normalizeGpuDevice({
      id,
      name: fields[2],
      utilizationPercent: fields[3],
      memoryUsedMb: fields[4],
      memoryTotalMb: fields[5],
      temperatureC: fields[6],
      powerWatts: fields[7]
    })
    if (normalized.ok) devices.push(normalized.device)
    else warnings.push(`Ignored nvidia-smi row ${row + 1}: ${normalized.reason}`)
  }
  return { devices, warnings }
}

export interface ParsedNvidiaProcesses {
  byGpuUuid: Map<string, string>
  warnings: string[]
}

export function parseNvidiaProcessOutput(stdout: string): ParsedNvidiaProcesses {
  const candidates = new Map<string, { name: string; memoryMb: number }>()
  const warnings: string[] = []
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim())
  for (let row = 0; row < lines.length; row += 1) {
    const fields = parseCsvLine(lines[row]!)
    const uuid = fields?.[0]?.trim()
    const name = fields?.[1]?.trim()
    const memoryMb = Number(fields?.[2])
    if (!fields || fields.length !== 3 || !uuid || !name || !Number.isFinite(memoryMb)) {
      warnings.push(`Ignored malformed nvidia-smi process row ${row + 1}.`)
      continue
    }
    const current = candidates.get(uuid)
    if (!current || memoryMb > current.memoryMb) candidates.set(uuid, { name, memoryMb })
  }
  return { byGpuUuid: new Map([...candidates].map(([uuid, value]) => [uuid, value.name])), warnings }
}

export interface NvidiaSmiGpuSourceOptions {
  runner?: FixedGpuCommandRunner
  timeoutMs?: number
  nodeId?: string
  now?: () => number
  platform?: () => NodeJS.Platform
}

export class NvidiaSmiGpuSource implements GpuSampleSource {
  readonly id = 'local:nvidia-smi'
  readonly location = 'local' as const
  readonly nodeId: string
  private readonly runner: FixedGpuCommandRunner
  private readonly timeoutMs: number
  private readonly now: () => number
  private readonly currentPlatform: () => NodeJS.Platform

  constructor(options: NvidiaSmiGpuSourceOptions = {}) {
    this.runner = options.runner ?? nodeExecFileGpuRunner
    this.timeoutMs = Math.trunc(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    if (this.timeoutMs < 100 || this.timeoutMs > 60_000) throw new Error('nvidia-smi timeout must be between 100ms and 60s')
    this.nodeId = options.nodeId ?? 'local'
    this.now = options.now ?? Date.now
    this.currentPlatform = options.platform ?? platform
  }

  async sample(signal: AbortSignal): Promise<GpuObservation> {
    const observedAt = this.now()
    const currentPlatform = this.currentPlatform()
    if (currentPlatform !== 'win32' && currentPlatform !== 'linux') {
      return {
        status: 'unsupported',
        observedAt,
        devices: [],
        reason: `nvidia-smi GPU telemetry is not supported on ${currentPlatform}.`,
        warnings: []
      }
    }
    try {
      const result = await this.runner.run({
        executable: NVIDIA_SMI_EXECUTABLE,
        args: NVIDIA_SMI_ARGS,
        timeoutMs: this.timeoutMs,
        maxOutputBytes: MAX_NVIDIA_OUTPUT_BYTES,
        signal
      })
      const parsed = parseNvidiaSmiOutput(result.stdout)
      if (parsed.devices.length === 0) {
        return {
          status: 'unavailable',
          observedAt: this.now(),
          devices: [],
          reason: result.stdout.trim()
            ? 'nvidia-smi returned no valid measured GPU devices.'
            : 'nvidia-smi returned no GPU devices.',
          warnings: parsed.warnings
        }
      }
      let devices = parsed.devices
      const warnings = [...parsed.warnings]
      try {
        const processes = await this.runner.run({
          executable: NVIDIA_SMI_EXECUTABLE,
          args: NVIDIA_SMI_PROCESS_ARGS,
          timeoutMs: this.timeoutMs,
          maxOutputBytes: MAX_NVIDIA_OUTPUT_BYTES,
          signal
        })
        const parsedProcesses = parseNvidiaProcessOutput(processes.stdout)
        warnings.push(...parsedProcesses.warnings)
        devices = devices.map((device) => {
          const processName = parsedProcesses.byGpuUuid.get(device.id)
          return processName ? { ...device, processName } : device
        })
      } catch (error) {
        if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
        warnings.push('GPU process attribution is unavailable from nvidia-smi.')
      }
      return { status: 'observed', observedAt: this.now(), devices, warnings }
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
      const missing = error instanceof FixedGpuCommandError && error.code === 'ENOENT'
      return {
        status: 'unavailable',
        observedAt: this.now(),
        devices: [],
        reason: missing
          ? 'nvidia-smi was not found; NVIDIA driver telemetry is unavailable.'
          : 'nvidia-smi could not be queried; GPU measurements are unavailable.',
        warnings: []
      }
    }
  }
}

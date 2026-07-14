import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { cpus, platform } from 'os'
import { getLocalProviderSettings } from './config'

// Phase 34.6: read-only, honest GPU / local-runtime telemetry. It NEVER fabricates
// utilization. On NVIDIA machines it queries nvidia-smi (read-only, timeout-bounded);
// elsewhere it reports `unavailable` with a clear reason. It also reports which Ollama
// endpoint is configured and whether it is local or remote — remote GPU telemetry is
// explicitly out of reach from Ollama's API and is reported as such.

export interface GpuDevice {
  name: string
  utilizationPercent?: number
  memoryUsedMb?: number
  memoryTotalMb?: number
  temperatureC?: number
}

export interface GpuOllamaInfo {
  configuredBaseUrl: string
  endpointKind: 'local' | 'remote'
  /** Honest note about telemetry reach for this endpoint. */
  note?: string
}

export interface CpuStatus {
  name: string
  logicalCores: number
  utilizationPercent: number
  source: 'os-times'
}

export interface GpuStatusResult {
  status: 'observed' | 'unavailable'
  /** Why telemetry is unavailable, when it is. */
  reason?: string
  platform: NodeJS.Platform
  source: 'nvidia-smi' | 'system-profiler' | 'none'
  gpus: GpuDevice[]
  cpu?: CpuStatus
  ollama: GpuOllamaInfo
}

const NVIDIA_TIMEOUT_MS = 3_000
const SYSTEM_PROFILER_TIMEOUT_MS = 5_000
const CPU_SAMPLE_MS = 180

interface CpuTimeSnapshot {
  idle: number
  total: number
}

function cpuTimeSnapshot(): CpuTimeSnapshot | null {
  const cores = cpus()
  if (!cores.length) return null
  return cores.reduce<CpuTimeSnapshot>(
    (sum, core) => {
      const total = Object.values(core.times).reduce((timeSum, value) => timeSum + value, 0)
      return { idle: sum.idle + core.times.idle, total: sum.total + total }
    },
    { idle: 0, total: 0 }
  )
}

async function readCpuStatus(): Promise<CpuStatus | undefined> {
  const cores = cpus()
  const first = cpuTimeSnapshot()
  if (!cores.length || !first) return undefined
  await new Promise<void>((resolve) => setTimeout(resolve, CPU_SAMPLE_MS))
  const second = cpuTimeSnapshot()
  if (!second) return undefined
  const totalDelta = second.total - first.total
  const idleDelta = second.idle - first.idle
  const utilizationPercent = totalDelta > 0
    ? Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100))
    : 0
  return {
    name: cores[0].model.trim() || `${cores.length}-core CPU`,
    logicalCores: cores.length,
    utilizationPercent,
    source: 'os-times'
  }
}

function runNvidiaSmi(): Promise<{ ok: boolean; stdout: string; missing: boolean }> {
  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits'],
      { timeout: NVIDIA_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => {
        if (err) {
          const missing = (err as NodeJS.ErrnoException).code === 'ENOENT'
          resolve({ ok: false, stdout: '', missing })
          return
        }
        resolve({ ok: true, stdout: stdout ?? '', missing: false })
      }
    )
  })
}

function num(value: string): number | undefined {
  const n = Number(value.trim())
  return Number.isFinite(n) ? n : undefined
}

function parseNvidia(stdout: string): GpuDevice[] {
  const devices: GpuDevice[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split(',').map((p) => p.trim())
    if (!parts[0]) continue
    devices.push({
      name: parts[0],
      utilizationPercent: num(parts[1] ?? ''),
      memoryUsedMb: num(parts[2] ?? ''),
      memoryTotalMb: num(parts[3] ?? ''),
      temperatureC: num(parts[4] ?? '')
    })
  }
  return devices
}

function runSystemProfiler(): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      'system_profiler',
      ['SPDisplaysDataType', '-json'],
      { timeout: SYSTEM_PROFILER_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024, windowsHide: true },
      (err, stdout) => resolve({ ok: !err, stdout: err ? '' : stdout ?? '' })
    )
  })
}

function parseMacDisplays(stdout: string): GpuDevice[] {
  try {
    const parsed = JSON.parse(stdout) as { SPDisplaysDataType?: Array<Record<string, unknown>> }
    return (parsed.SPDisplaysDataType ?? [])
      .map((display) => {
        const name = [display.sppci_model, display._name]
          .find((value) => typeof value === 'string' && value.trim())
        return name ? { name: String(name) } : null
      })
      .filter((device): device is GpuDevice => device !== null)
  } catch {
    return []
  }
}

function ollamaInfo(): GpuOllamaInfo {
  const baseUrl = getLocalProviderSettings().baseUrl
  let host = ''
  try {
    host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase()
  } catch {
    /* keep empty host */
  }
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0'
  return {
    configuredBaseUrl: baseUrl,
    endpointKind: isLocal ? 'local' : 'remote',
    note: isLocal
      ? undefined
      : 'Remote GPU telemetry is not exposed by the Ollama API. Add a companion/agent, SSH command, or a secured telemetry endpoint to surface the remote machine GPU.'
  }
}

export async function getGpuStatus(): Promise<GpuStatusResult> {
  const plat = platform()
  const ollama = ollamaInfo()
  const cpu = await readCpuStatus()

  if (plat === 'win32' || plat === 'linux') {
    const res = await runNvidiaSmi()
    if (res.ok) {
      const gpus = parseNvidia(res.stdout)
      if (gpus.length > 0) {
        return { status: 'observed', platform: plat, source: 'nvidia-smi', gpus, cpu, ollama }
      }
      return { status: 'unavailable', reason: 'nvidia-smi returned no GPUs.', platform: plat, source: 'nvidia-smi', gpus: [], cpu, ollama }
    }
    return {
      status: 'unavailable',
      reason: res.missing
        ? 'nvidia-smi was not found. GPU utilization is available on NVIDIA machines with the NVIDIA driver installed.'
        : 'nvidia-smi could not be queried on this machine.',
      platform: plat,
      source: 'none',
      gpus: [],
      cpu,
      ollama
    }
  }

  if (plat === 'darwin') {
    const profiler = await runSystemProfiler()
    const gpus = profiler.ok ? parseMacDisplays(profiler.stdout) : []
    if (gpus.length > 0) {
      return {
        status: 'observed',
        reason: 'GPU hardware is observed with system_profiler. Live utilization and temperature require privileged macOS telemetry and are intentionally left blank.',
        platform: plat,
        source: 'system-profiler',
        gpus,
        cpu,
        ollama
      }
    }
    return {
      status: 'unavailable',
      reason: 'GPU hardware could not be read with system_profiler. Akorith does not request elevated access or fabricate utilization.',
      platform: plat,
      source: 'none',
      gpus: [],
      cpu,
      ollama
    }
  }

  return {
    status: 'unavailable',
    reason: `GPU telemetry is not supported on this platform (${plat}).`,
    platform: plat,
    source: 'none',
    gpus: [],
    cpu,
    ollama
  }
}

export function registerGpuStatusIpc(): void {
  ipcMain.handle('gpu:getStatus', async (): Promise<GpuStatusResult> => {
    try {
      return await getGpuStatus()
    } catch (err) {
      return {
        status: 'unavailable',
        reason: err instanceof Error ? err.message : String(err),
        platform: platform(),
        source: 'none',
        gpus: [],
        cpu: await readCpuStatus(),
        ollama: ollamaInfo()
      }
    }
  })
}

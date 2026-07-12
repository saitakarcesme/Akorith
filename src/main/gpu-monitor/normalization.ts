import type { NormalizedGpuDevice } from './types'

const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,159}$/
const NOT_OBSERVED = new Set(['', 'n/a', '[n/a]', 'not supported', '[not supported]', 'unknown', '-'])

export interface RawGpuDevice {
  id: unknown
  name: unknown
  utilizationPercent?: unknown
  memoryUsedMb?: unknown
  memoryTotalMb?: unknown
  temperatureC?: unknown
  powerWatts?: unknown
  processName?: unknown
  activeModel?: unknown
}

export type GpuDeviceNormalization =
  | { ok: true; device: NormalizedGpuDevice }
  | { ok: false; reason: string }

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const clean = value.trim()
  if (!clean || clean.length > max || /[\0\r\n]/.test(clean)) return undefined
  return clean
}

/** Invalid and unsupported readings stay absent; they are never clamped or synthesized. */
export function normalizeMetric(value: unknown, minimum: number, maximum: number): number | undefined {
  let candidate: number
  if (typeof value === 'number') {
    candidate = value
  } else if (typeof value === 'string') {
    const clean = value.trim().toLowerCase()
    if (NOT_OBSERVED.has(clean) || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(clean)) return undefined
    candidate = Number(clean)
  } else {
    return undefined
  }
  return Number.isFinite(candidate) && candidate >= minimum && candidate <= maximum ? candidate : undefined
}

export function hasMeasuredGpuMetric(device: NormalizedGpuDevice): boolean {
  return (
    device.utilizationPercent !== undefined ||
    device.memoryUsedMb !== undefined ||
    device.memoryTotalMb !== undefined ||
    device.temperatureC !== undefined ||
    device.powerWatts !== undefined
  )
}

export function normalizeGpuDevice(raw: RawGpuDevice): GpuDeviceNormalization {
  const id = boundedText(raw.id, 160)
  if (!id || !DEVICE_ID_PATTERN.test(id)) return { ok: false, reason: 'GPU device id is invalid.' }
  const name = boundedText(raw.name, 240)
  if (!name) return { ok: false, reason: 'GPU device name is invalid.' }

  const utilizationPercent = normalizeMetric(raw.utilizationPercent, 0, 100)
  const memoryUsedMb = normalizeMetric(raw.memoryUsedMb, 0, 10_000_000)
  const memoryTotalMb = normalizeMetric(raw.memoryTotalMb, 0, 10_000_000)
  const temperatureC = normalizeMetric(raw.temperatureC, -100, 250)
  const powerWatts = normalizeMetric(raw.powerWatts, 0, 100_000)
  if (memoryUsedMb !== undefined && memoryTotalMb !== undefined && memoryUsedMb > memoryTotalMb) {
    return { ok: false, reason: `GPU ${id} reported memory usage greater than total memory.` }
  }

  const device: NormalizedGpuDevice = {
    id,
    name,
    ...(utilizationPercent !== undefined ? { utilizationPercent } : {}),
    ...(memoryUsedMb !== undefined ? { memoryUsedMb } : {}),
    ...(memoryTotalMb !== undefined ? { memoryTotalMb } : {}),
    ...(temperatureC !== undefined ? { temperatureC } : {}),
    ...(powerWatts !== undefined ? { powerWatts } : {})
  }
  const processName = boundedText(raw.processName, 240)
  const activeModel = boundedText(raw.activeModel, 240)
  if (processName !== undefined) device.processName = processName
  if (activeModel !== undefined) device.activeModel = activeModel
  if (!hasMeasuredGpuMetric(device)) return { ok: false, reason: `GPU ${id} exposed no supported measurements.` }
  return { ok: true, device }
}

export function bytesToMebibytes(value: unknown): number | undefined {
  const bytes = normalizeMetric(value, 0, Number.MAX_SAFE_INTEGER)
  return bytes === undefined ? undefined : bytes / (1024 * 1024)
}

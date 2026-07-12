import { validateHardwareSnapshot } from '../remote-node/validation'
import type { RemoteGpuDevice, RemoteHardwareSnapshot } from '../remote-node/types'
import { bytesToMebibytes, normalizeGpuDevice } from './normalization'
import type { GpuObservation, GpuSampleSource, NormalizedGpuDevice } from './types'

const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,159}$/

/**
 * Transport-neutral seam for the paired remote-node protocol. The HTTP/Tailscale
 * client owns authentication; the monitor receives only the public hardware
 * response and an AbortSignal.
 */
export interface RemoteNodeGpuClient {
  readonly nodeId: string
  fetchGpuSnapshot(signal: AbortSignal): Promise<unknown>
}

function safeReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/[\0\r\n]+/g, ' ').trim().slice(0, 300) || 'unknown transport failure'
}

function extractHardwareSnapshot(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input
  const value = input as Record<string, unknown>
  if ('observedAt' in value && 'gpu' in value) return value
  if (value.hardware && typeof value.hardware === 'object') return value.hardware
  if (value.health && typeof value.health === 'object') {
    const health = value.health as Record<string, unknown>
    if (health.hardware && typeof health.hardware === 'object') return health.hardware
  }
  if (value.catalog && typeof value.catalog === 'object') {
    const catalog = value.catalog as Record<string, unknown>
    if (catalog.hardware && typeof catalog.hardware === 'object') return catalog.hardware
  }
  return input
}

function normalizeRemoteDevice(device: RemoteGpuDevice) {
  return normalizeGpuDevice({
    id: device.id,
    name: device.name,
    utilizationPercent: device.utilizationPercent,
    memoryUsedMb: bytesToMebibytes(device.memoryUsedBytes),
    memoryTotalMb: bytesToMebibytes(device.memoryTotalBytes),
    temperatureC: device.temperatureC,
    powerWatts: device.powerWatts,
    processName: device.processName,
    activeModel: device.activeModel
  })
}

export class RemoteNodeGpuSource implements GpuSampleSource {
  readonly id: string
  readonly nodeId: string
  readonly location = 'remote' as const

  constructor(private readonly client: RemoteNodeGpuClient, private readonly now: () => number = Date.now) {
    const nodeId = client.nodeId.trim()
    if (!NODE_ID_PATTERN.test(nodeId)) throw new Error('remote GPU node id is invalid')
    this.nodeId = nodeId
    this.id = `remote:${nodeId}:gpu`
  }

  async sample(signal: AbortSignal): Promise<GpuObservation> {
    let raw: unknown
    try {
      raw = await this.client.fetchGpuSnapshot(signal)
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error
      return {
        status: 'disconnected',
        observedAt: this.now(),
        devices: [],
        reason: `Remote node ${this.nodeId} is disconnected: ${safeReason(error)}`,
        warnings: []
      }
    }

    const validated = validateHardwareSnapshot(extractHardwareSnapshot(raw))
    if (!validated.ok || !validated.value) {
      return {
        status: 'unavailable',
        observedAt: this.now(),
        devices: [],
        reason: `Remote node ${this.nodeId} returned invalid GPU telemetry: ${validated.error ?? 'invalid snapshot'}`,
        warnings: []
      }
    }
    return this.fromHardware(validated.value)
  }

  private fromHardware(hardware: RemoteHardwareSnapshot): GpuObservation {
    if (hardware.gpu.status === 'unavailable') {
      return {
        status: 'unavailable',
        observedAt: hardware.observedAt,
        devices: [],
        reason: hardware.gpu.reason,
        warnings: []
      }
    }
    const devices: NormalizedGpuDevice[] = []
    const warnings: string[] = []
    for (const remote of hardware.gpu.devices) {
      const normalized = normalizeRemoteDevice(remote)
      if (normalized.ok) devices.push(normalized.device)
      else warnings.push(`Ignored remote GPU ${remote.id}: ${normalized.reason}`)
    }
    if (devices.length === 0) {
      return {
        status: 'unavailable',
        observedAt: hardware.observedAt,
        devices: [],
        reason: `Remote node ${this.nodeId} reported no valid measured GPU devices.`,
        warnings
      }
    }
    return { status: 'observed', observedAt: hardware.observedAt, devices, warnings }
  }
}

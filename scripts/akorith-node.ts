import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { arch, cpus, freemem, homedir, platform, totalmem } from 'node:os'
import { dirname, resolve } from 'node:path'
import { NvidiaSmiGpuSource } from '../src/main/gpu-monitor/index.ts'
import {
  PairingAuthority,
  RemoteNodeHttpServer,
  RemoteNodeService,
  defaultRemoteRuntimeDiscoverers,
  type PersistedPairingAuthorityState,
  type RemoteHardwareSnapshot
} from '../src/main/remote-node/index.ts'

interface NodeState {
  schemaVersion: 1
  nodeId: string
  pairing: PersistedPairingAuthorityState
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

function safeName(value: string | undefined): string {
  const clean = (value ?? 'Akorith Node').trim().replace(/[\0\r\n]/g, '').slice(0, 100)
  return clean || 'Akorith Node'
}

function safePort(value: string | undefined): number {
  const port = Number(value ?? 47841)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be between 1024 and 65535.')
  return port
}

async function readState(path: string): Promise<NodeState | null> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    if (value.schemaVersion !== 1 || typeof value.nodeId !== 'string' || !value.pairing) return null
    return value as unknown as NodeState
  } catch {
    return null
  }
}

async function writeState(path: string, state: NodeState): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
}

async function hardware(source: NvidiaSmiGpuSource): Promise<RemoteHardwareSnapshot> {
  const observation = await source.sample(new AbortController().signal)
  return {
    observedAt: observation.observedAt,
    platform: platform(),
    architecture: arch(),
    cpu: { logicalCores: cpus().length, model: cpus()[0]?.model },
    memory: { totalBytes: totalmem(), freeBytes: freemem() },
    gpu: observation.status === 'observed'
      ? {
          status: 'observed',
          devices: observation.devices.map((device) => ({
            id: device.id,
            name: device.name,
            ...(device.utilizationPercent !== undefined ? { utilizationPercent: device.utilizationPercent } : {}),
            ...(device.memoryUsedMb !== undefined ? { memoryUsedBytes: device.memoryUsedMb * 1024 * 1024 } : {}),
            ...(device.memoryTotalMb !== undefined ? { memoryTotalBytes: device.memoryTotalMb * 1024 * 1024 } : {}),
            ...(device.temperatureC !== undefined ? { temperatureC: device.temperatureC } : {}),
            ...(device.powerWatts !== undefined ? { powerWatts: device.powerWatts } : {})
          }))
        }
      : { status: 'unavailable', devices: [], reason: observation.reason }
  }
}

async function main(): Promise<void> {
  const host = argument('host') ?? '127.0.0.1'
  const port = safePort(argument('port'))
  const nodeName = safeName(argument('name'))
  const statePath = resolve(argument('state') ?? `${homedir()}/.akorith-node/state.json`)
  const previous = await readState(statePath)
  const authority = new PairingAuthority({ persistedState: previous?.pairing })
  const state: NodeState = {
    schemaVersion: 1,
    nodeId: previous?.nodeId ?? randomUUID(),
    pairing: authority.exportState()
  }
  const gpu = new NvidiaSmiGpuSource({ nodeId: state.nodeId })
  const protocol = new RemoteNodeService({
    nodeId: state.nodeId,
    nodeName,
    pairingAuthority: authority,
    runtimeDiscoverers: defaultRemoteRuntimeDiscoverers(),
    hardwareProvider: () => hardware(gpu)
  })
  const server = new RemoteNodeHttpServer({
    service: protocol,
    pairingAuthority: authority,
    host,
    port,
    allowLan: flag('allow-lan'),
    persistAuthority: async (pairing) => {
      state.pairing = pairing
      await writeState(statePath, state)
    }
  })
  await writeState(statePath, state)
  const address = await server.start()
  const challenge = authority.beginPairing({ nodeName })
  console.log(`Akorith Node "${nodeName}" is listening on ${address.host}:${address.port}.`)
  if (address.host === '0.0.0.0' || address.host === '::') {
    console.log('LAN binding is enabled. Use a trusted LAN or Tailscale address; do not expose this plaintext port to the public internet.')
  }
  console.log(`Pairing id: ${challenge.pairingId}`)
  console.log(`Pairing code: ${challenge.code} (expires ${new Date(challenge.expiresAt).toLocaleTimeString()})`)
  console.log(`State: ${statePath}`)

  const stop = async (): Promise<void> => {
    await writeState(statePath, { ...state, pairing: authority.exportState() }).catch(() => undefined)
    await server.stop()
  }
  process.once('SIGINT', () => void stop().finally(() => process.exit(0)))
  process.once('SIGTERM', () => void stop().finally(() => process.exit(0)))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})

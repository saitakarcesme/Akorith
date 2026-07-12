import { ipcMain } from 'electron'
import { getDb } from '../db'
import { getGpuMonitorSnapshot } from '../gpu-monitor'
import { getRemoteNodeClientManager } from '../remote-node'
import { DashboardTelemetryService, type DashboardHeatmapMode } from './service'

function service(): DashboardTelemetryService {
  return new DashboardTelemetryService({ database: getDb(), gpuSnapshot: getGpuMonitorSnapshot })
}

export function registerDashboardTelemetryIpc(): void {
  ipcMain.handle('dashboardTelemetry:overview', () => service().overview())
  ipcMain.handle('dashboardTelemetry:heatmap', (_event, mode: DashboardHeatmapMode) => service().heatmap(mode))
  ipcMain.handle('dashboardTelemetry:gpu', async () => {
    const local = service().gpu() as { status: string; observedAt: number; reason?: string; devices: Record<string, unknown>[]; warnings: string[] }
    const remoteDevices: Record<string, unknown>[] = []
    const warnings = [...local.warnings]
    const manager = getRemoteNodeClientManager()
    for (const node of await manager.list()) {
      try {
        const { catalog } = await manager.catalog(node.id)
        if (catalog.hardware.gpu.status === 'observed') {
          for (const device of catalog.hardware.gpu.devices) {
            remoteDevices.push({
              id: device.id,
              nodeId: node.id,
              nodeLabel: node.name,
              location: 'remote',
              name: device.name,
              ...(device.utilizationPercent !== undefined ? { utilizationPercent: device.utilizationPercent } : {}),
              ...(device.memoryUsedBytes !== undefined ? { memoryUsedMb: device.memoryUsedBytes / (1024 * 1024) } : {}),
              ...(device.memoryTotalBytes !== undefined ? { memoryTotalMb: device.memoryTotalBytes / (1024 * 1024) } : {}),
              ...(device.temperatureC !== undefined ? { temperatureC: device.temperatureC } : {}),
              ...(device.powerWatts !== undefined ? { powerWatts: device.powerWatts } : {}),
              ...(device.activeModel ? { activeModel: device.activeModel } : {}),
              ...(device.processName ? { processName: device.processName } : {})
            })
          }
        } else {
          warnings.push(`${node.name}: ${catalog.hardware.gpu.reason}`)
        }
      } catch (error) {
        warnings.push(`${node.name}: ${error instanceof Error ? error.message : 'remote GPU unavailable'}`.slice(0, 300))
      }
    }
    const devices = [...local.devices, ...remoteDevices]
    return {
      status: devices.length > 0 ? 'observed' : local.status,
      observedAt: Date.now(),
      ...(devices.length === 0 && local.reason ? { reason: local.reason } : {}),
      devices,
      warnings
    }
  })
}

import { ipcMain } from 'electron'
import { getDb } from '../db'
import { getGpuMonitorSnapshot } from '../gpu-monitor'
import { DashboardTelemetryService, type DashboardHeatmapMode } from './service'

function service(): DashboardTelemetryService {
  return new DashboardTelemetryService({ database: getDb(), gpuSnapshot: getGpuMonitorSnapshot })
}

export function registerDashboardTelemetryIpc(): void {
  ipcMain.handle('dashboardTelemetry:overview', () => service().overview())
  ipcMain.handle('dashboardTelemetry:heatmap', (_event, mode: DashboardHeatmapMode) => service().heatmap(mode))
  ipcMain.handle('dashboardTelemetry:gpu', () => service().gpu())
}

import { app, safeStorage } from 'electron'
import { RemoteNodeClientManager } from './client-manager'

let manager: RemoteNodeClientManager | null = null

export function getRemoteNodeClientManager(): RemoteNodeClientManager {
  manager ??= new RemoteNodeClientManager({ dataDir: app.getPath('userData'), safeStorage })
  return manager
}

export async function startRemoteNodeClientRuntime(): Promise<void> {
  await getRemoteNodeClientManager().startMonitoring()
}

export function stopRemoteNodeClientRuntime(): void {
  manager?.stopMonitoring()
  manager = null
}

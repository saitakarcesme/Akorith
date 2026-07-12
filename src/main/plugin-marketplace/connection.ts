import type {
  PluginConnectionSnapshot,
  PluginHealthReport,
  PluginInstallation,
  PluginManifest
} from './types'

export interface ResolveConnectionInput {
  manifest: PluginManifest
  installation: PluginInstallation
  credentialsPresent: boolean
  health?: PluginHealthReport | null
  now?: number
}

export function disconnectedHealthReport(
  pluginId: string,
  summary = 'No connection has been verified.',
  now = Date.now()
): PluginHealthReport {
  return {
    pluginId,
    status: 'disconnected',
    checkedAt: now,
    summary,
    checks: [],
    verified: false,
    authenticated: false
  }
}

export function isHealthReportFresh(manifest: PluginManifest, report: PluginHealthReport, now = Date.now()): boolean {
  return report.checkedAt <= now && now - report.checkedAt <= manifest.health.staleAfterMs
}

export function resolvePluginConnection(input: ResolveConnectionInput): PluginConnectionSnapshot {
  const { manifest, installation, health } = input
  const now = input.now ?? Date.now()
  const snapshot = (state: PluginConnectionSnapshot['state'], reason: string): PluginConnectionSnapshot => ({
    pluginId: manifest.id,
    state,
    reason,
    checkedAt: health?.checkedAt ?? null
  })

  if (installation.pluginId !== manifest.id) return snapshot('error', 'Installation and manifest ids do not match.')
  if (installation.state === 'error') return snapshot('error', installation.lastError ?? 'Plugin lifecycle failed.')
  if (
    !installation.installedVersion ||
    installation.state === 'not-installed' ||
    installation.state === 'installing' ||
    installation.state === 'uninstalling'
  ) {
    return snapshot('not-installed', 'Plugin is not installed.')
  }
  if (installation.state !== 'enabled') return snapshot('disabled', 'Plugin is installed but not enabled.')

  // Enabling a credential plugin is allowed before sign-in, but it remains honestly disconnected.
  if (manifest.auth.required && !input.credentialsPresent) {
    return snapshot('disconnected', 'A protected credential must be configured before connecting.')
  }
  if (!health) return snapshot('disconnected', 'No adapter health probe has run.')
  if (health.pluginId !== manifest.id) return snapshot('error', 'Health report belongs to a different plugin.')
  if (health.status === 'checking') return snapshot('connecting', 'Connection health check is running.')
  if (!health.verified) return snapshot('disconnected', 'Connection has not been verified by an adapter probe.')
  if (!isHealthReportFresh(manifest, health, now)) return snapshot('disconnected', 'The last verified health report is stale.')
  if (manifest.auth.required && !health.authenticated) {
    return snapshot('disconnected', 'The adapter did not verify authentication.')
  }

  switch (health.status) {
    case 'healthy':
      return snapshot('connected', health.summary)
    case 'degraded':
      return snapshot('degraded', health.summary)
    case 'unhealthy':
      return snapshot('error', health.summary)
    case 'disconnected':
    case 'unknown':
      return snapshot('disconnected', health.summary)
  }
}

// Phase 35: plugin foundation types. This is a REAL registry with permission
// metadata and honest diagnostics — but NOT an execution runtime. No plugin code
// is loaded or run in this phase; enable/disable is config-only.

export type PluginId = string

export type PluginKind =
  | 'agent'
  | 'tool'
  | 'workbench'
  | 'automation'
  | 'model_provider'
  | 'integration'
  | 'memory'
  | 'browser'
  | 'telemetry'

export type PluginStatus = 'built_in' | 'available' | 'unavailable' | 'disabled' | 'planned' | 'error'

export type PluginPermission =
  | 'filesystem_read'
  | 'filesystem_write'
  | 'terminal_read'
  | 'terminal_write'
  | 'network'
  | 'git_read'
  | 'git_write'
  | 'browser'
  | 'memory_read'
  | 'memory_write'
  | 'model_runtime'
  | 'controller_api'
  | 'secrets'

export interface PluginDiagnostic {
  pluginId: PluginId
  available: boolean
  status: PluginStatus
  message: string
  checkedAt: number
  details?: string
}

export interface PluginManifest {
  id: PluginId
  name: string
  version: string
  kind: PluginKind
  description: string
  /** Baseline status before a live diagnostic runs (e.g. planned / built_in). */
  status: PluginStatus
  permissions: PluginPermission[]
  /** Optional future entry point — unused in Phase 35 (no execution). */
  entry?: string
  settingsSchema?: Record<string, unknown>
  safetyNotes: string[]
  docsUrl?: string
  builtIn: boolean
}

/** Runtime view returned to the renderer/controller: manifest + live state. */
export interface PluginInfo extends PluginManifest {
  enabled: boolean
  /** Effective status after enable/disable + diagnostics are applied. */
  effectiveStatus: PluginStatus
  diagnostic?: PluginDiagnostic
}

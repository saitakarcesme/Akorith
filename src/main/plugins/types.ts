// Plugin registry types. External tools are never loaded as arbitrary code:
// diagnostics detect trusted local CLIs and enabled capabilities are advertised
// to the already-sandboxed Workspace / Goal provider flow.

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
  /** Read-only command used for bounded availability diagnostics. */
  diagnosticCommand?: { command: string; args: string[] }
  /** Short prompt hint exposed only when the tool is installed and enabled. */
  capabilityHint?: string
  /** Human-readable, opt-in install guidance; Akorith never installs silently. */
  installHint?: string
  builtIn: boolean
}

/** Runtime view returned to the renderer/controller: manifest + live state. */
export interface PluginInfo extends PluginManifest {
  enabled: boolean
  /** Effective status after enable/disable + diagnostics are applied. */
  effectiveStatus: PluginStatus
  diagnostic?: PluginDiagnostic
}

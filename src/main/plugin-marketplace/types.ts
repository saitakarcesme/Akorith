export const PLUGIN_CATEGORIES = [
  'source-control',
  'project-management',
  'knowledge',
  'communication',
  'productivity',
  'design',
  'delivery',
  'observability',
  'analytics',
  'database',
  'infrastructure',
  'cloud',
  'ai',
  'browser',
  'local-tools'
] as const

export type PluginCategory = (typeof PLUGIN_CATEGORIES)[number]

export const PLUGIN_AUTH_MODES = [
  'none',
  'oauth2',
  'api-token',
  'service-account',
  'connection-string',
  'cli',
  'local-socket'
] as const

export type PluginAuthMode = (typeof PLUGIN_AUTH_MODES)[number]

export interface PluginPublisher {
  id: string
  name: string
  url?: string
}

export interface PluginIcon {
  kind: 'brand' | 'symbol'
  value: string
  /** A built-in symbol that is always available when a brand asset is missing. */
  fallback: 'plug' | 'database' | 'cloud' | 'terminal' | 'browser'
}

export type PluginCapabilityAccess = 'read' | 'write' | 'execute' | 'observe' | 'manage'

export interface PluginCapability {
  id: string
  title: string
  description: string
  access: PluginCapabilityAccess
}

export type PluginPermissionKind =
  | 'network'
  | 'credentials'
  | 'filesystem'
  | 'process'
  | 'browser'
  | 'database'
  | 'container'
  | 'cloud'

export type PluginPermissionRisk = 'low' | 'medium' | 'high'

export interface PluginPermission {
  id: string
  kind: PluginPermissionKind
  access: 'read' | 'write' | 'execute' | 'connect' | 'manage'
  required: boolean
  /** Concrete hosts/resources, or an explicit user-selected scope. Never an unrestricted wildcard. */
  scopes: string[]
  risk: PluginPermissionRisk
  rationale: string
}

export interface PluginPermissionGrant {
  permissionId: string
  granted: boolean
  grantedAt: number
  scopes: string[]
}

export type PluginConfigFieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'url'
  | 'path'
  | 'credential-reference'

export interface PluginConfigField {
  type: PluginConfigFieldType
  title: string
  description: string
  required: boolean
  default?: string | number | boolean
  choices?: string[]
  min?: number
  max?: number
}

export interface PluginConfigSchema {
  version: 1
  additionalProperties: false
  fields: Record<string, PluginConfigField>
}

export interface PluginAuthContract {
  mode: PluginAuthMode
  required: boolean
  /** Logical secret kinds stored behind credential references, never config values. */
  credentialKinds: string[]
  helpUrl?: string
}

export interface PluginSkillContribution {
  id: string
  label: string
  description: string
  capabilityIds: string[]
}

export interface PluginMcpContribution {
  id: string
  label: string
  /** Marketplace manifests declare an adapter surface; they do not launch an arbitrary command. */
  transport: 'adapter'
  availability: 'requires-connection' | 'local-probe'
  capabilityIds: string[]
}

export type PluginHookEvent =
  | 'before-command'
  | 'after-command'
  | 'connection-changed'
  | 'health-changed'

export interface PluginHookContribution {
  id: string
  event: PluginHookEvent
  description: string
}

export interface PluginAppContribution {
  id: string
  label: string
  description: string
  surface: 'panel' | 'resource-picker' | 'settings'
  capabilityIds: string[]
}

export interface PluginCommandContribution {
  id: string
  title: string
  description: string
  capabilityIds: string[]
  permissionIds: string[]
  requiresConnection: boolean
}

export interface PluginHealthContract {
  probe: 'adapter' | 'local'
  timeoutMs: number
  staleAfterMs: number
  /** No plugin starts connected. A verified probe must produce the first connected state. */
  initialState: 'disconnected'
}

export interface PluginManifest {
  schemaVersion: 1
  id: string
  name: string
  publisher: PluginPublisher
  version: string
  category: PluginCategory
  description: string
  icon: PluginIcon
  capabilities: PluginCapability[]
  skills: PluginSkillContribution[]
  mcpServers: PluginMcpContribution[]
  hooks: PluginHookContribution[]
  apps: PluginAppContribution[]
  commands: PluginCommandContribution[]
  permissions: PluginPermission[]
  configSchema: PluginConfigSchema
  auth: PluginAuthContract
  health: PluginHealthContract
}

export type PluginLifecycleState =
  | 'not-installed'
  | 'installing'
  | 'installed'
  | 'enabling'
  | 'enabled'
  | 'disabling'
  | 'disabled'
  | 'updating'
  | 'uninstalling'
  | 'error'

export type PluginLifecycleAction = 'install' | 'enable' | 'disable' | 'update' | 'uninstall'

export type PluginStableLifecycleState = 'not-installed' | 'installed' | 'enabled' | 'disabled'

export interface PluginPendingLifecycleOperation {
  action: PluginLifecycleAction
  startedAt: number
  returnState: PluginStableLifecycleState
  targetVersion?: string
}

export interface PluginInstallation {
  pluginId: string
  state: PluginLifecycleState
  installedVersion: string | null
  installedAt: number | null
  updatedAt: number
  pending: PluginPendingLifecycleOperation | null
  recoveryState: PluginStableLifecycleState | null
  lastError: string | null
}

export type PluginHealthStatus = 'unknown' | 'checking' | 'healthy' | 'degraded' | 'unhealthy' | 'disconnected'

export interface PluginHealthCheck {
  id: string
  status: 'pass' | 'warn' | 'fail'
  message: string
}

export interface PluginHealthReport {
  pluginId: string
  status: PluginHealthStatus
  checkedAt: number
  summary: string
  checks: PluginHealthCheck[]
  /** True only when an adapter/local probe actually ran; static manifest data is never verified. */
  verified: boolean
  /** Required for credential-backed plugins to become connected. */
  authenticated: boolean
}

export type PluginConnectionState =
  | 'not-installed'
  | 'disabled'
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'degraded'
  | 'error'

export interface PluginConnectionSnapshot {
  pluginId: string
  state: PluginConnectionState
  reason: string
  checkedAt: number | null
}

export interface CredentialMetadata {
  id: string
  pluginId: string
  label: string
  createdAt: number
  updatedAt: number
}

export interface CredentialInput {
  id: string
  pluginId: string
  label: string
  secret: string | Uint8Array
}

export interface CredentialUseContext {
  pluginId: string
  purpose: string
}

export interface CredentialVault {
  put(input: CredentialInput): Promise<CredentialMetadata>
  has(id: string): Promise<boolean>
  list(pluginId?: string): Promise<CredentialMetadata[]>
  delete(id: string): Promise<boolean>
  /** Plaintext exists only for the duration of this trusted main-process callback. */
  use(id: string, context: CredentialUseContext, consumer: (secret: Uint8Array) => void | Promise<void>): Promise<void>
}

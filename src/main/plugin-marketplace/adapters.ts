import type {
  CredentialUseContext,
  PluginHealthReport,
  PluginManifest,
  PluginPermissionGrant
} from './types'

export type PluginConfigValue = string | number | boolean | null

/** Least-privilege credential view exposed to trusted main-process adapters. */
export interface PluginCredentialAccess {
  has(id: string): Promise<boolean>
  use(
    id: string,
    context: CredentialUseContext,
    consumer: (secret: Uint8Array) => void | Promise<void>
  ): Promise<void>
}

export interface PluginAdapterContext {
  pluginId: string
  config: Readonly<Record<string, PluginConfigValue>>
  permissionGrants: readonly PluginPermissionGrant[]
  credentials: PluginCredentialAccess
  signal: AbortSignal
  audit(event: PluginAdapterAuditEvent): void
}

export interface PluginAdapterAuditEvent {
  pluginId: string
  kind: 'probe' | 'command-started' | 'command-completed' | 'command-failed' | 'disconnected'
  commandId?: string
  message: string
  at: number
}

export interface PluginCommandRequest {
  pluginId: string
  commandId: string
  input: Readonly<Record<string, unknown>>
  correlationId: string
}

export interface PluginCommandResult {
  pluginId: string
  commandId: string
  correlationId: string
  ok: boolean
  summary: string
  /** Structured, secret-free output. Adapters must redact provider payloads before returning. */
  output?: Readonly<Record<string, unknown>>
  errorCode?: string
}

/**
 * Third-party behavior lives behind this contract. The marketplace domain itself
 * performs no network calls and does not load arbitrary manifest entry points.
 */
export interface PluginRuntimeAdapter {
  readonly pluginId: string
  probe(context: PluginAdapterContext): Promise<PluginHealthReport>
  invoke(request: PluginCommandRequest, context: PluginAdapterContext): Promise<PluginCommandResult>
  disconnect(context: PluginAdapterContext): Promise<void>
}

export function assertAdapterContract(manifest: PluginManifest, adapter: PluginRuntimeAdapter): void {
  if (adapter.pluginId !== manifest.id) {
    throw new Error(`Adapter ${adapter.pluginId} does not match manifest ${manifest.id}.`)
  }
  if (typeof adapter.probe !== 'function' || typeof adapter.invoke !== 'function' || typeof adapter.disconnect !== 'function') {
    throw new Error(`Adapter ${adapter.pluginId} does not implement the runtime contract.`)
  }
}

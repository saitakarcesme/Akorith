import type { PluginPermission } from './types'

// Phase 35: human-readable descriptions of each permission a plugin can request.
// Surfaced in the Plugins UI so the access a future plugin would need is explicit
// before any execution runtime exists.

export const PERMISSION_LABELS: Record<PluginPermission, string> = {
  filesystem_read: 'Read files',
  filesystem_write: 'Write files',
  terminal_read: 'Read terminal output',
  terminal_write: 'Send to terminal',
  network: 'Network access',
  git_read: 'Read git state',
  git_write: 'Modify git (commit/push)',
  browser: 'Control a browser',
  memory_read: 'Read memory/skills',
  memory_write: 'Write memory/skills',
  model_runtime: 'Use model runtime',
  controller_api: 'Use controller API',
  secrets: 'Access secrets'
}

/** Permissions considered sensitive (highlighted in the UI). */
export const SENSITIVE_PERMISSIONS = new Set<PluginPermission>([
  'filesystem_write',
  'terminal_write',
  'git_write',
  'browser',
  'memory_write',
  'secrets'
])

export function permissionLabel(permission: PluginPermission): string {
  return PERMISSION_LABELS[permission] ?? permission
}

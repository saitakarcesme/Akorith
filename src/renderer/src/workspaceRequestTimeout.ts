const DEFAULT_WORKSPACE_REQUEST_TIMEOUT_MS = 12 * 60 * 1_000
const LOCAL_WORKSPACE_REQUEST_TIMEOUT_MS = 22 * 60 * 1_000

/**
 * Provider timers begin after context preparation, while this outer request
 * timer begins immediately. Keep a small margin around the ten-minute CLI
 * window; Local additionally needs room for two bounded attempts and checks.
 */
export function workspaceRequestTimeoutMs(providerId: string): number {
  return providerId === 'local'
    ? LOCAL_WORKSPACE_REQUEST_TIMEOUT_MS
    : DEFAULT_WORKSPACE_REQUEST_TIMEOUT_MS
}

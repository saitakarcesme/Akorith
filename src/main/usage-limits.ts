import { ipcMain } from 'electron'
import { getProviderUsageSince } from './db'
import { getUsageLimitConfig, setUsageLimitConfig, type UsageLimitConfig } from './config'

// Phase 39: honest usage-limit visibility. Akorith has NO official access to
// Claude/Codex remaining subscription limits — it never scrapes accounts, reads
// cookies, stores tokens, or fabricates remaining values. It surfaces:
//  - Akorith's OWN recorded in-app provider usage in a rolling 5h / 7d window
//  - the user-configured limit labels (if set)
//  - an explicit note about what is and isn't counted.

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

export interface UsageWindowRow {
  providerId: string
  events: number
  tokens: number
}

export interface UsageLimitView {
  windows: { fiveHour: UsageWindowRow[]; weekly: UsageWindowRow[] }
  config: UsageLimitConfig
  checkedAt: number
  note: string
}

function getView(): UsageLimitView {
  const now = Date.now()
  return {
    windows: {
      fiveHour: getProviderUsageSince(now - FIVE_HOURS_MS),
      weekly: getProviderUsageSince(now - SEVEN_DAYS_MS)
    },
    config: getUsageLimitConfig(),
    checkedAt: now,
    note:
      'Exact remaining Claude/Codex subscription limits are not exposed by their CLIs, so Akorith shows its own recorded in-app provider usage and the limits you configure. Terminal usage (Olympus/Gaia/Atlantis CLI sessions) is not counted here.'
  }
}

export function registerUsageLimitsIpc(): void {
  ipcMain.handle('usageLimits:get', (): UsageLimitView => getView())
  ipcMain.handle('usageLimits:setConfig', (_event, patch: unknown): UsageLimitConfig => {
    const safe = (patch ?? {}) as Partial<UsageLimitConfig>
    return setUsageLimitConfig(safe)
  })
}

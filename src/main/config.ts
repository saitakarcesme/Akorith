// loopex.config.json — single home for reading/writing user config.
// Lives in Electron's userData dir; created with defaults on first run.

import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ProviderConfigEntry } from './providers/types'

export interface BridgeSettings {
  /** Append Enter after a bridged send so the CLI executes immediately.
   *  Default OFF — text lands at the prompt and waits. */
  autoEnter: boolean
}

export interface LoopexConfig {
  providers: Record<string, ProviderConfigEntry>
  bridge?: Partial<BridgeSettings>
}

export const DEFAULT_CONFIG: LoopexConfig = {
  providers: {
    claude: { enabled: true },
    chatgpt: { enabled: true },
    local: { enabled: true, baseUrl: 'http://localhost:11434' }
  },
  bridge: { autoEnter: false }
}

export function configPath(): string {
  return join(app.getPath('userData'), 'loopex.config.json')
}

export function loadConfig(): LoopexConfig {
  const file = configPath()
  if (!existsSync(file)) {
    writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf8')
    return DEFAULT_CONFIG
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as LoopexConfig
    if (!parsed || typeof parsed.providers !== 'object' || parsed.providers === null) {
      throw new Error('missing "providers" object')
    }
    return parsed
  } catch (err) {
    console.error(`[config] invalid ${file} — falling back to defaults:`, err)
    return DEFAULT_CONFIG
  }
}

export function getBridgeSettings(): BridgeSettings {
  return { autoEnter: loadConfig().bridge?.autoEnter ?? false }
}

export function setBridgeAutoEnter(autoEnter: boolean): BridgeSettings {
  const config = loadConfig()
  config.bridge = { ...config.bridge, autoEnter }
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n', 'utf8')
  return { autoEnter }
}

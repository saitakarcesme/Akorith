import { app, ipcMain } from 'electron'
import { existsSync, copyFileSync, mkdirSync, statSync } from 'fs'
import { basename, join, normalize } from 'path'
import {
  configPath,
  getBridgeSettings,
  getDigestSettings,
  getRouterSettings,
  getTheme,
  loadConfig
} from './config'
import {
  dbPath,
  ensureDbReady,
  isDbReady,
  listProjects,
  listSessions,
  type ProjectRow,
  type SessionRow
} from './db'
import {
  cleanDisplayName,
  cleanSidebarWidth,
  cleanStartupView,
  countStartupRows,
  resolveStartupRestore,
  type StartupHydrationCounts,
  type StartupRestoreRequest,
  type StartupRestoreTarget,
  type StartupView
} from './startupSnapshotCore'

interface LegacyDataCandidate {
  name: string
  path: string
  dbExists: boolean
  dbBytes: number
  configExists: boolean
}

interface StartupMigrationResult {
  attempted: boolean
  copied: string[]
  skipped: string[]
  warnings: string[]
  candidates: LegacyDataCandidate[]
}

interface StartupSnapshotSettings {
  theme: 'dark' | 'light'
  bridge: { autoEnter: boolean }
  digest: { enabled: boolean; workingDir: string }
  router: { classifierModel: string; tierProviders: Record<string, string | null> }
  providers: string[]
}

export interface StartupSnapshot {
  app: {
    name: 'Akorith'
    userDataPath: string
    dbPath: string
    configPath: string
  }
  settings: StartupSnapshotSettings
  preferences: {
    displayName: string | null
    sidebarWidth: number | null
    lastView: StartupView
  }
  projects: ProjectRow[]
  sessions: SessionRow[]
  restore: StartupRestoreTarget
  diagnostics: {
    dbReady: boolean
    configReady: boolean
    loadedAt: number
    counts: StartupHydrationCounts
    warnings: string[]
    migration: StartupMigrationResult
  }
}

let lastMigrationResult: StartupMigrationResult | null = null

function fileBytes(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function samePath(a: string, b: string): boolean {
  return normalize(a).toLowerCase() === normalize(b).toLowerCase()
}

function collectLegacyCandidates(): LegacyDataCandidate[] {
  const appData = app.getPath('appData')
  const current = app.getPath('userData')
  const names = Array.from(new Set(['Electron', 'letsgetit', 'Loopex', 'Akorith']))
  return names
    .map((name) => {
      const path = join(appData, name)
      const db = join(path, 'loopex.db')
      const config = join(path, 'loopex.config.json')
      return {
        name,
        path,
        dbExists: existsSync(db),
        dbBytes: fileBytes(db),
        configExists: existsSync(config)
      }
    })
    .filter((candidate) => !samePath(candidate.path, current))
}

function copyIfMissing(source: string, target: string, label: string, result: StartupMigrationResult): void {
  if (!existsSync(source)) return
  if (existsSync(target)) {
    result.skipped.push(`${label}: target already exists`)
    return
  }
  copyFileSync(source, target)
  result.copied.push(label)
}

export function prepareStartupUserData(): StartupMigrationResult {
  if (lastMigrationResult) return lastMigrationResult
  if (process.env.AKORITH_SKIP_LEGACY_MIGRATION === '1') {
    lastMigrationResult = {
      attempted: false,
      copied: [],
      skipped: ['Legacy userData migration disabled for this isolated run.'],
      warnings: [],
      candidates: []
    }
    return lastMigrationResult
  }
  const result: StartupMigrationResult = {
    attempted: false,
    copied: [],
    skipped: [],
    warnings: [],
    candidates: collectLegacyCandidates()
  }
  const currentDir = app.getPath('userData')
  const currentDb = dbPath()
  const currentConfig = configPath()
  const legacyWithDb = result.candidates.find((candidate) => candidate.dbExists && candidate.dbBytes > 0)
  const legacyWithConfig = result.candidates.find((candidate) => candidate.configExists)
  try {
    mkdirSync(currentDir, { recursive: true })
    if (legacyWithDb && !existsSync(currentDb)) {
      result.attempted = true
      const sourceDb = join(legacyWithDb.path, 'loopex.db')
      copyIfMissing(sourceDb, currentDb, `${legacyWithDb.name}/loopex.db`, result)
      for (const suffix of ['-wal', '-shm']) {
        copyIfMissing(`${sourceDb}${suffix}`, `${currentDb}${suffix}`, `${legacyWithDb.name}/loopex.db${suffix}`, result)
      }
    } else if (legacyWithDb && existsSync(currentDb)) {
      result.skipped.push(`${basename(currentDb)} already exists in current Akorith userData`)
    }
    if (legacyWithConfig && !existsSync(currentConfig)) {
      result.attempted = true
      copyIfMissing(
        join(legacyWithConfig.path, 'loopex.config.json'),
        currentConfig,
        `${legacyWithConfig.name}/loopex.config.json`,
        result
      )
    } else if (legacyWithConfig && existsSync(currentConfig)) {
      result.skipped.push(`${basename(currentConfig)} already exists in current Akorith userData`)
    }
  } catch (err) {
    result.warnings.push(`legacy userData check failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (result.copied.length > 0) {
    console.info(`[startup] copied missing legacy userData files: ${result.copied.join(', ')}`)
  }
  if (result.warnings.length > 0) {
    console.warn(`[startup] legacy userData warnings: ${result.warnings.join('; ')}`)
  }
  lastMigrationResult = result
  return result
}

function safeSettings(warnings: string[]): { configReady: boolean; settings: StartupSnapshotSettings } {
  try {
    const config = loadConfig()
    const router = getRouterSettings()
    const digest = getDigestSettings()
    return {
      configReady: true,
      settings: {
        theme: getTheme(),
        bridge: getBridgeSettings(),
        digest: {
          enabled: digest.enabled,
          workingDir: digest.workingDir ?? ''
        },
        router: {
          classifierModel: router.classifierModel ?? '',
          tierProviders: Object.fromEntries(
            Object.entries(router.tierMap).map(([tier, target]) => [tier, target.providerId ?? null])
          )
        },
        providers: Object.keys(config.providers ?? {})
      }
    }
  } catch (err) {
    warnings.push(`config load failed: ${err instanceof Error ? err.message : String(err)}`)
    return {
      configReady: false,
      settings: {
        theme: 'dark',
        bridge: { autoEnter: false },
        digest: { enabled: false, workingDir: '' },
        router: { classifierModel: '', tierProviders: {} },
        providers: []
      }
    }
  }
}

export async function getStartupSnapshot(request: StartupRestoreRequest = {}): Promise<StartupSnapshot> {
  const warnings: string[] = []
  const migration = prepareStartupUserData()
  warnings.push(...migration.warnings)
  const { configReady, settings } = safeSettings(warnings)
  let projects: ProjectRow[] = []
  let sessions: SessionRow[] = []
  try {
    await ensureDbReady()
    projects = listProjects()
    sessions = listSessions()
  } catch (err) {
    warnings.push(`database load failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  const counts = countStartupRows(projects, sessions)
  return {
    app: {
      name: 'Akorith',
      userDataPath: app.getPath('userData'),
      dbPath: dbPath(),
      configPath: configPath()
    },
    settings,
    preferences: {
      displayName: cleanDisplayName(request.displayName),
      sidebarWidth: cleanSidebarWidth(request.sidebarWidth),
      lastView: cleanStartupView(request.lastView)
    },
    projects,
    sessions,
    restore: resolveStartupRestore(projects, sessions, request),
    diagnostics: {
      dbReady: isDbReady(),
      configReady,
      loadedAt: Date.now(),
      counts,
      warnings,
      migration
    }
  }
}

export function registerStartupSnapshotIpc(): void {
  ipcMain.handle('app:getStartupSnapshot', (_event, request: StartupRestoreRequest = {}) => getStartupSnapshot(request))
}

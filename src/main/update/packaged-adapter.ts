import type {
  ElectronUpdaterLike,
  ElectronUpdaterLoadResult,
  UpdateModuleLoader
} from './packaged-types'

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

function isElectronUpdaterLike(value: unknown): value is ElectronUpdaterLike {
  const candidate = object(value)
  return Boolean(
    candidate &&
      typeof candidate['checkForUpdates'] === 'function' &&
      typeof candidate['downloadUpdate'] === 'function' &&
      typeof candidate['quitAndInstall'] === 'function' &&
      typeof candidate['on'] === 'function' &&
      typeof candidate['removeListener'] === 'function'
  )
}

function updaterFromModule(value: unknown): ElectronUpdaterLike | undefined {
  const direct = object(value)
  if (isElectronUpdaterLike(direct?.['autoUpdater'])) return direct['autoUpdater']
  const fallback = object(direct?.['default'])
  if (isElectronUpdaterLike(fallback?.['autoUpdater'])) return fallback['autoUpdater']
  if (isElectronUpdaterLike(fallback)) return fallback
  return undefined
}

const defaultModuleLoader: UpdateModuleLoader = async (specifier) => import(/* @vite-ignore */ specifier)

/**
 * Resolve electron-updater only at runtime.  Builds that do not ship the
 * dependency remain functional and report an unsupported updater state.
 */
export async function loadOptionalElectronUpdater(
  loader: UpdateModuleLoader = defaultModuleLoader
): Promise<ElectronUpdaterLoadResult> {
  try {
    const loaded = await loader('electron-updater')
    const updater = updaterFromModule(loaded)
    if (!updater) {
      return { available: false, reason: 'The electron-updater module does not expose a compatible autoUpdater.' }
    }
    return { available: true, updater }
  } catch {
    return { available: false, reason: 'The electron-updater module is not installed in this build.' }
  }
}

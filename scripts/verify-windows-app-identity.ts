import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const root = join(__dirname, '..')

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8')
}

function pass(label: string): void {
  console.log(`[ok] ${label}`)
}

function fail(label: string): never {
  console.error(`[fail] ${label}`)
  process.exit(1)
}

function assert(value: unknown, label: string): void {
  if (!value) fail(label)
  pass(label)
}

const pkg = JSON.parse(read('package.json')) as {
  productName?: string
  build?: {
    appId?: string
    productName?: string
    win?: { executableName?: string; icon?: string }
    nsis?: Record<string, unknown>
    publish?: { provider?: string; owner?: string; repo?: string }[]
  }
  dependencies?: Record<string, string>
}
const main = read('src/main/index.ts')
const updateRuntime = read('src/main/update/index.ts')
const refresh = read('scripts/refresh-windows-app.ps1')

assert(pkg.productName === 'Akorith', 'package productName is Akorith')
assert(pkg.build?.appId === 'com.akorith.app', 'electron-builder appId is stable')
assert(pkg.build?.productName === 'Akorith', 'electron-builder productName is Akorith')
assert(pkg.build?.win?.executableName === 'Akorith', 'Windows executableName is Akorith')
assert(pkg.build?.win?.icon === 'build/icon.ico', 'Windows executable icon is build/icon.ico')
assert(pkg.build?.nsis?.shortcutName === 'Akorith', 'NSIS shortcutName is Akorith')
assert(pkg.build?.nsis?.installerIcon === 'build/icon.ico', 'NSIS installer icon is configured')
assert(pkg.build?.nsis?.uninstallerIcon === 'build/icon.ico', 'NSIS uninstaller icon is configured')
assert(pkg.build?.nsis?.installerHeaderIcon === 'build/icon.ico', 'NSIS header icon is configured')
assert(existsSync(join(root, 'build/icon.ico')), 'build/icon.ico exists')
assert(main.includes("app.setAppUserModelId(AKORITH_APP_ID)") && main.indexOf('app.setAppUserModelId') < main.indexOf('createWindow()'), 'main sets AppUserModelID before BrowserWindow creation')
assert(main.includes("['build', 'icon.ico']") && main.includes('...(icon ? { icon } : {})'), 'BrowserWindow icon resolves to build/icon.ico on Windows')
assert(refresh.includes('$AppId = \'com.akorith.app\'') && refresh.includes('$AppName = \'Akorith\''), 'refresh script uses Akorith app id/name')
assert(refresh.includes('Akorith.exe') && refresh.includes('Electron.lnk'), 'refresh script handles installed exe and stale Electron shortcuts')
assert(Boolean(pkg.dependencies?.['electron-updater']), 'electron-updater is a production dependency')
assert(pkg.build?.publish?.some((entry) => entry.provider === 'github' && entry.owner === 'saitakarcesme' && entry.repo === 'Akorith'), 'public GitHub Releases feed is configured')
assert(updateRuntime.includes('PackagedUpdaterService') && updateRuntime.includes('authorizeInstall'), 'main uses the packaged updater with explicit install authorization')
assert(!/git\s+(?:fetch|pull|merge)|refresh-windows-app/.test(updateRuntime), 'installed update runtime does not run source Git or refresh scripts')

console.log('Windows app identity verification passed.')

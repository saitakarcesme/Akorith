import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import { _electron as electron } from 'playwright-core'

const here = dirname(fileURLToPath(import.meta.url))
const entry = join(here, 'smoke', 'electron-native-smoke.cjs')
const userData = await mkdtemp(join(tmpdir(), 'akorith-electron-smoke-'))
let electronApplication

function normalized(path) {
  const value = resolve(path)
  return process.platform === 'win32' ? value.toLowerCase() : value
}

try {
  electronApplication = await electron.launch({
    executablePath: electronPath,
    args: [entry],
    env: {
      ...process.env,
      AKORITH_SMOKE_USER_DATA: userData
    },
    timeout: 30_000
  })

  const result = await electronApplication.evaluate(async ({ app }) => {
    const deadline = Date.now() + 25_000
    while (Date.now() < deadline) {
      const state = globalThis.__AKORITH_NATIVE_SMOKE__
      if (state?.status === 'complete') {
        return { ...state, effectiveUserData: app.getPath('userData') }
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
    }
    return { status: 'complete', ok: false, error: 'native smoke result timed out', effectiveUserData: app.getPath('userData') }
  })

  if (!result.ok) throw new Error(result.error || 'Electron native smoke failed')
  if (normalized(result.userData) !== normalized(userData) || normalized(result.effectiveUserData) !== normalized(userData)) {
    throw new Error(`Electron smoke escaped its temp userData directory: ${result.userData}`)
  }
  if (!result.database?.ok || !result.pty?.ok) throw new Error('native module smoke returned an incomplete result')

  console.log(
    `electron-native-smoke: ok (Electron ${result.electronVersion}, ABI ${result.modulesAbi}, SQLite + PTY, temp userData)`
  )
} finally {
  if (electronApplication) await electronApplication.close().catch(() => undefined)
  await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'

const requestedScript = process.argv[2]
if (!requestedScript) {
  console.error('usage: node scripts/run-electron-typescript.mjs <script.ts> [...args]')
  process.exit(2)
}

const here = dirname(fileURLToPath(import.meta.url))
const bootstrap = resolve(here, 'smoke', 'electron-typescript-runner.cjs')
const script = resolve(process.cwd(), requestedScript)
const scriptArgs = process.argv.slice(3)

const child = spawn(electronPath, [bootstrap, script, ...scriptArgs], {
  cwd: process.cwd(),
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', AKORITH_TEST_MODE: '1' },
  stdio: 'inherit',
  windowsHide: true
})

child.once('error', (error) => {
  console.error(`failed to start Electron test runtime: ${error.message}`)
  process.exitCode = 1
})

child.once('exit', (code, signal) => {
  if (signal) {
    console.error(`Electron test runtime ended via ${signal}`)
    process.exitCode = 1
    return
  }
  process.exitCode = code ?? 1
})

import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { platform } from 'os'

// Phase 35: honest, read-only availability checks for plugin foundations. Each runs
// a `--version`-style command (timeout-bounded) or checks a well-known install path.
// Nothing here executes plugin logic, reads browser data, or ingests anything.

const CHECK_TIMEOUT_MS = 4_000

export interface RawDiagnostic {
  available: boolean
  message: string
  details?: string
}

function runVersion(command: string, args: string[]): Promise<RawDiagnostic> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: CHECK_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const missing = (err as NodeJS.ErrnoException).code === 'ENOENT'
        resolve({
          available: false,
          message: missing ? `${command} is not installed or not on PATH.` : `${command} could not be queried.`
        })
        return
      }
      const out = (stdout || stderr || '').trim().split('\n')[0] || 'detected'
      resolve({ available: true, message: `Detected: ${out}`, details: out })
    })
  })
}

/** OpenCode (Gaia): version + a SAFE auth presence check. We never read or print
 *  token values — only whether `opencode auth list` reports a configured provider. */
export async function checkOpenCode(): Promise<RawDiagnostic> {
  const version = await runVersion('opencode', ['--version'])
  if (!version.available) return version
  const signedIn = await new Promise<boolean | null>((resolve) => {
    execFile('opencode', ['auth', 'list'], { timeout: CHECK_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        resolve(null)
        return
      }
      const out = `${stdout ?? ''}${stderr ?? ''}`.toLowerCase()
      // Heuristic only — presence of a provider word, never the secret itself.
      const empty = /no\s+(providers|credentials)|not\s+(logged|signed)|empty/.test(out) || out.trim().length === 0
      const hasProvider = /(anthropic|openai|github|opencode|google|provider)/.test(out) && !empty
      resolve(hasProvider)
    })
  })
  const authNote =
    signedIn === true
      ? 'Terminal (Gaia) ready · a provider is signed in.'
      : signedIn === false
        ? 'Terminal (Gaia) ready · not signed in — run: opencode auth login'
        : 'Terminal (Gaia) ready · sign in with: opencode auth login'
  return { available: true, message: `${version.message} · ${authNote}`, details: version.details }
}

export function checkGitHubCli(): Promise<RawDiagnostic> {
  return runVersion('gh', ['--version'])
}

export function checkOllamaCli(): Promise<RawDiagnostic> {
  return runVersion('ollama', ['--version'])
}

/** Chroma: detect Python + the chromadb module without importing anything heavy. */
export async function checkChroma(): Promise<RawDiagnostic> {
  for (const python of ['python3', 'python']) {
    const probe = await new Promise<RawDiagnostic | null>((resolve) => {
      execFile(
        python,
        ['-c', 'import chromadb,sys; sys.stdout.write(chromadb.__version__)'],
        { timeout: CHECK_TIMEOUT_MS, windowsHide: true },
        (err, stdout) => {
          if (err) {
            const missing = (err as NodeJS.ErrnoException).code === 'ENOENT'
            // python missing → try the next interpreter; import error → report it.
            resolve(missing ? null : { available: false, message: `${python} found, but chromadb is not installed.` })
            return
          }
          const version = (stdout || '').trim()
          resolve({ available: true, message: `chromadb ${version} detected via ${python}.`, details: version })
        }
      )
    })
    if (probe) return probe
  }
  return { available: false, message: 'Python (python3/python) was not found, so chromadb cannot be detected.' }
}

const CHROME_PATHS: Record<string, string[]> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'
  ],
  win32: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
  ],
  linux: []
}

/** Chrome/Chromium detection by well-known install path or `which`. No profile access. */
export async function checkChrome(): Promise<RawDiagnostic> {
  const plat = platform()
  for (const path of CHROME_PATHS[plat] ?? []) {
    if (existsSync(path)) return { available: true, message: 'Chrome/Chromium detected.', details: path }
  }
  if (plat === 'linux') {
    for (const command of ['google-chrome', 'chromium', 'chromium-browser']) {
      const probe = await runVersion(command, ['--version'])
      if (probe.available) return probe
    }
  }
  return {
    available: false,
    message: 'Chrome/Chromium was not found in the standard install locations.'
  }
}

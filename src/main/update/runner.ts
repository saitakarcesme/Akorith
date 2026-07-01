import { execFile, spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { getUpdateStatus, maskRemoteUrl, repoRoot, runGit } from './checker'
import type { UpdateLogEntry, UpdateRunOptions, UpdateRunResult } from './types'

// Phase 39: the update runner. It ONLY fast-forwards main after the read-only check
// says it's safe. No reset --hard, no discarding changes, no force anything, no
// remote-supplied commands. npm steps run fixed arguments only.

const NPM_TIMEOUT_MS = 8 * 60_000

/** Bound + mask command output before it is shown/logged. */
function safeOutput(text: string, max = 4000): string {
  const masked = maskRemoteUrl(text)
    // never surface bearer/token-looking strings
    .replace(/\b(token|bearer|password|secret)[=:]\S+/gi, '$1=***')
  return masked.length > max ? `${masked.slice(0, max)}\n…(truncated)` : masked
}

function runNpm(cwd: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    // Fixed args only — `shell: true` keeps npm/npm.cmd resolution cross-platform.
    execFile('npm', args, { cwd, timeout: NPM_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true, shell: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: safeOutput(`${stdout ?? ''}\n${stderr ?? ''}`.trim()) })
    })
  })
}

function launchWindowsRefresh(cwd: string): { ok: boolean; output: string } {
  const script = join(cwd, 'scripts', 'refresh-windows-app.ps1')
  if (!existsSync(script)) return { ok: false, output: `Missing ${script}` }
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
    cwd,
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })
  child.unref()
  return { ok: true, output: `Started Windows refresh script: ${script}` }
}

export async function runUpdate(options: UpdateRunOptions): Promise<UpdateRunResult> {
  const logs: UpdateLogEntry[] = []
  const log = (command: string, ok: boolean, output: string): void => {
    logs.push({ command, ok, output: safeOutput(output), at: Date.now() })
  }

  // Re-check freshly (with a fetch) before touching anything.
  const pre = await getUpdateStatus(true)
  if (pre.mode === 'packaged' && pre.runtimeMode === 'packaged-windows') {
    if (!pre.sourceCheckoutPath || !pre.canUpdateInstalledApp) {
      return { ok: false, status: pre, logs, error: 'Packaged Windows update needs a clean Akorith source checkout.', restartRecommended: false }
    }
    const cwd = pre.sourceCheckoutPath
    if (pre.isDirty) {
      return { ok: false, status: pre, logs, error: 'Source checkout has local changes. Commit or stash them first.', restartRecommended: false }
    }
    if (pre.behindBy > 0) {
      const fetched = await runGit(cwd, ['fetch', 'origin', '--quiet'], 60_000)
      log('git fetch origin', fetched.ok, fetched.stdout || fetched.stderr || 'ok')
      if (!fetched.ok) {
        return { ok: false, status: await getUpdateStatus(false), logs, error: 'git fetch failed.', restartRecommended: false }
      }
      if (pre.currentBranch !== 'main') {
        const switched = await runGit(cwd, ['switch', 'main'])
        log('git switch main', switched.ok, switched.stdout || switched.stderr)
        if (!switched.ok) {
          return { ok: false, status: await getUpdateStatus(false), logs, error: 'Could not switch source checkout to main.', restartRecommended: false }
        }
      }
      const pulled = await runGit(cwd, ['merge', '--ff-only', 'origin/main'])
      log('git merge --ff-only origin/main', pulled.ok, pulled.stdout || pulled.stderr)
      if (!pulled.ok) {
        return { ok: false, status: await getUpdateStatus(false), logs, error: 'Fast-forward failed in the source checkout.', restartRecommended: false }
      }
    }
    if (options.runInstall) {
      const installed = await runNpm(cwd, ['install', '--no-audit', '--no-fund'])
      log('npm install --no-audit --no-fund', installed.ok, installed.output)
      if (!installed.ok) return { ok: false, status: await getUpdateStatus(false), logs, error: 'npm install failed.', restartRecommended: false }
    }
    const launched = launchWindowsRefresh(cwd)
    log('scripts/refresh-windows-app.ps1', launched.ok, launched.output)
    return {
      ok: launched.ok,
      status: await getUpdateStatus(false),
      logs,
      error: launched.ok ? undefined : launched.output,
      restartRecommended: launched.ok
    }
  }
  if (pre.mode !== 'git' || !pre.repoPath) {
    return { ok: false, status: pre, logs, error: 'Not a git/source install — nothing to update.', restartRecommended: false }
  }
  if (pre.isDirty) {
    return { ok: false, status: pre, logs, error: 'Working tree has local changes. Commit or stash them first — the updater never discards changes.', restartRecommended: false }
  }
  if (!pre.hasUpdate) {
    return { ok: true, status: pre, logs, error: undefined, restartRecommended: false }
  }

  const cwd = pre.repoPath

  // 1) fetch
  const fetched = await runGit(cwd, ['fetch', 'origin', '--quiet'], 60_000)
  log('git fetch origin', fetched.ok, fetched.stdout || fetched.stderr || 'ok')
  if (!fetched.ok) {
    return { ok: false, status: await getUpdateStatus(false), logs, error: 'git fetch failed.', restartRecommended: false }
  }

  // 2) switch to main if needed
  if (pre.currentBranch !== 'main') {
    const switched = await runGit(cwd, ['switch', 'main'])
    log('git switch main', switched.ok, switched.stdout || switched.stderr)
    if (!switched.ok) {
      return { ok: false, status: await getUpdateStatus(false), logs, error: 'Could not switch to main.', restartRecommended: false }
    }
  }

  // 3) fast-forward only — never a merge commit, never a reset
  const pulled = await runGit(cwd, ['merge', '--ff-only', 'origin/main'])
  log('git merge --ff-only origin/main', pulled.ok, pulled.stdout || pulled.stderr)
  if (!pulled.ok) {
    return { ok: false, status: await getUpdateStatus(false), logs, error: 'Fast-forward failed (history diverged). Resolve manually — the updater will not force.', restartRecommended: false }
  }

  // 4) optional npm install
  if (options.runInstall) {
    const installed = await runNpm(cwd, ['install', '--no-audit', '--no-fund'])
    log('npm install --no-audit --no-fund', installed.ok, installed.output)
  }

  // 5) optional build
  if (options.runBuild) {
    const built = await runNpm(cwd, ['run', 'build'])
    log('npm run build', built.ok, built.output)
  }

  const post = await getUpdateStatus(false)
  return { ok: true, status: post, logs, restartRecommended: true }
}

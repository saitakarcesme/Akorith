// Test-lab IPC + persistence wiring (Phase 7). Bridges the electron-free core
// in testlab.ts to the renderer over validated channels, owns the ephemeral
// sandbox lifecycle (create under OS temp, prune to keepLastN), streams live
// output, and persists each run to test_runs for Phase 8 to consume.

import { app, ipcMain, type WebContents } from 'electron'
import { spawn } from 'child_process'
import { existsSync, mkdirSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { isAbsolute, join, relative, resolve } from 'path'
import { getTestSettings, setTestSourceRepo, type TestLabSettings } from './config'
import { createTestRun, listTestRuns, type TestRunRow } from './db'
import {
  buildRepoContext,
  detectFramework,
  parseGitHubRepoUrl,
  pruneSandboxes,
  runTests,
  snapshotSource,
  type Detection,
  type GeneratedFile,
  type RepoContext
} from './testlab'

const SANDBOX_BASE = join(tmpdir(), 'loopex-testlab')
const VALID_RUN_ID = /^[\w-]{1,64}$/
const MAX_FILES = 20
const MAX_FILE_BYTES = 500_000
const MAX_TOTAL_BYTES = 2_000_000
const GIT_CLONE_TIMEOUT_MS = 120_000

// Active runs, keyed by runId, so test:stop can abort the whole process tree.
const activeRuns = new Map<string, AbortController>()

interface RunArgs {
  runId: string
  sourceRepo: string
  targetDesc?: string
  providerId?: string
  model?: string
  framework: string
  testCommand: string
  installCommand?: string
  installDeps?: boolean
  files: GeneratedFile[]
  tokens?: number
  attempts?: number
  timeoutMs?: number
}

type RunResponse = { ok: true; run: TestRunRow } | { ok: false; error: string }
type ResolveSourceResponse =
  | { ok: true; path: string; label: string; cloned: boolean }
  | { ok: false; error: string }

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function githubCloneDir(owner: string, repo: string): string {
  const base = join(app.getPath('userData'), 'testlab-github-repos')
  return join(base, `${owner}__${repo}`)
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel)
}

function runGit(args: string[], cwd?: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolveDone) => {
    const child = spawn('git', args, {
      cwd,
      shell: false,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    })
    let output = ''
    const capture = (b: Buffer): void => {
      if (output.length < 8000) output += b.toString('utf8')
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }, GIT_CLONE_TIMEOUT_MS)
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    child.on('error', (err) => {
      clearTimeout(timer)
      resolveDone({ code: null, output: err.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolveDone({ code, output })
    })
  })
}

async function resolveSourceRepo(input: string): Promise<ResolveSourceResponse> {
  const trimmed = input.trim()
  const gh = parseGitHubRepoUrl(trimmed)
  if (!gh) {
    if (!trimmed || !existsSync(trimmed) || !isDirectory(trimmed)) {
      return { ok: false, error: 'source repo not found' }
    }
    return { ok: true, path: trimmed, label: trimmed, cloned: false }
  }

  const base = join(app.getPath('userData'), 'testlab-github-repos')
  const target = githubCloneDir(gh.owner, gh.repo)
  if (!isInside(base, target)) return { ok: false, error: 'invalid GitHub repo cache path' }
  mkdirSync(base, { recursive: true })

  if (existsSync(join(target, '.git')) && isDirectory(target)) {
    return { ok: true, path: target, label: gh.label, cloned: false }
  }
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true })
  }

  const res = await runGit(['clone', '--depth', '1', gh.cloneUrl, target])
  if (res.code !== 0) {
    return { ok: false, error: `git clone failed for ${gh.label}: ${res.output.trim() || `exit ${res.code}`}` }
  }
  return { ok: true, path: target, label: gh.label, cloned: true }
}

function validFiles(files: unknown): files is GeneratedFile[] {
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES) return false
  let total = 0
  for (const f of files) {
    if (typeof f?.path !== 'string' || typeof f?.content !== 'string') return false
    const bytes = Buffer.byteLength(f.content, 'utf8')
    if (bytes > MAX_FILE_BYTES) return false
    total += bytes
  }
  return total <= MAX_TOTAL_BYTES
}

async function handleRun(args: RunArgs, sender: WebContents): Promise<RunResponse> {
  if (
    typeof args?.runId !== 'string' ||
    !VALID_RUN_ID.test(args.runId) ||
    typeof args.sourceRepo !== 'string' ||
    !existsSync(args.sourceRepo) ||
    typeof args.testCommand !== 'string' ||
    args.testCommand.trim().length === 0 ||
    args.testCommand.length > 2_000 ||
    (args.installCommand !== undefined &&
      (typeof args.installCommand !== 'string' || args.installCommand.length > 2_000)) ||
    typeof args.framework !== 'string' ||
    !validFiles(args.files)
  ) {
    return { ok: false, error: 'invalid test:run payload' }
  }
  if (activeRuns.has(args.runId)) return { ok: false, error: 'run already in progress' }

  const settings = getTestSettings()
  const timeoutMs = Math.min(Math.max(args.timeoutMs ?? settings.timeoutMs, 1_000), 1_800_000)
  const installDeps = args.installDeps ?? settings.installDeps

  mkdirSync(SANDBOX_BASE, { recursive: true })
  const sandbox = join(SANDBOX_BASE, args.runId)
  mkdirSync(sandbox, { recursive: true })

  const onOutput = (chunk: string): void => {
    if (!sender.isDestroyed()) sender.send('test:output', { runId: args.runId, chunk })
  }
  const controller = new AbortController()
  activeRuns.set(args.runId, controller)

  try {
    onOutput(`\x1b[90m[loopex] snapshotting source (read-only) → sandbox\x1b[0m\r\n`)
    const snap = await snapshotSource(args.sourceRepo, sandbox)
    onOutput(`\x1b[90m[loopex] snapshot: ${snap.files} files via ${snap.mode}; sandbox=${sandbox}\x1b[0m\r\n`)

    const metrics = await runTests({
      sandbox,
      framework: args.framework,
      files: args.files,
      testCommand: args.testCommand,
      installCommand: args.installCommand,
      installDeps,
      timeoutMs,
      signal: controller.signal,
      onOutput
    })

    const run = createTestRun({
      sourceRepo: args.sourceRepo,
      targetDesc: args.targetDesc ?? null,
      providerId: args.providerId ?? null,
      model: args.model ?? null,
      framework: metrics.framework,
      passed: metrics.passed,
      failed: metrics.failed,
      errored: metrics.errored,
      durationMs: metrics.durationMs,
      exitCode: metrics.exitCode,
      tokens: args.tokens ?? null,
      attempts: args.attempts ?? 1,
      sandboxPath: sandbox,
      generatedFiles: args.files,
      rawOutput: metrics.rawOutput,
      status: metrics.status
    })

    // Prune AFTER persisting so older sandboxes are cleaned up — the row keeps
    // raw_output regardless. Keep the newest N (incl. this one) for debugging.
    try {
      pruneSandboxes(SANDBOX_BASE, settings.keepLastN)
    } catch {
      /* prune is best-effort */
    }

    return { ok: true, run }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    activeRuns.delete(args.runId)
  }
}

export function registerTestIpc(): void {
  ipcMain.handle('test:getSettings', (): TestLabSettings => getTestSettings())

  ipcMain.handle('test:setSourceRepo', (_event, dir: unknown): TestLabSettings => {
    if (typeof dir !== 'string') return getTestSettings()
    return setTestSourceRepo(dir.slice(0, 1_000))
  })

  ipcMain.handle('test:resolveSource', async (_event, args: { source: string }): Promise<ResolveSourceResponse> => {
    if (typeof args?.source !== 'string' || args.source.length > 1_000) {
      return { ok: false, error: 'invalid source repo' }
    }
    return resolveSourceRepo(args.source)
  })

  ipcMain.handle('test:detect', async (_event, args: { sourceRepo: string }): Promise<Detection | { error: string }> => {
    if (typeof args?.sourceRepo !== 'string' || !existsSync(args.sourceRepo)) {
      return { error: 'source repo not found' }
    }
    return detectFramework(args.sourceRepo)
  })

  // Phase 14.1: bounded, read-only repo structure + sample files so the test
  // generator imports real modules with real export names (reliability).
  ipcMain.handle('test:context', (_event, args: { sourceRepo: string }): RepoContext | { error: string } => {
    if (typeof args?.sourceRepo !== 'string' || !existsSync(args.sourceRepo)) {
      return { error: 'source repo not found' }
    }
    try {
      return buildRepoContext(args.sourceRepo)
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('test:run', (event, args: RunArgs) => handleRun(args, event.sender))

  ipcMain.on('test:stop', (_event, args: { runId: string }) => {
    if (typeof args?.runId !== 'string') return
    activeRuns.get(args.runId)?.abort()
  })

  ipcMain.handle('test:listRuns', (_event, args: { limit?: number }): TestRunRow[] =>
    listTestRuns(typeof args?.limit === 'number' ? args.limit : 50)
  )
}

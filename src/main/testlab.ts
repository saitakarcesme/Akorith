// Test-lab CORE (Phase 7) — deliberately ELECTRON-FREE so it can be exercised
// headlessly (node --experimental-strip-types) and unit-reasoned in isolation.
// The electron IPC + persistence wiring lives in testlab-ipc.ts.
//
// SAFETY CONTRACT (the whole point of this page):
//   - The source repo is READ-ONLY here. We only ever read from it; every write
//     goes into a caller-provided ephemeral sandbox dir.
//   - Generated/auto-run code executes with cwd = sandbox, a hard TIMEOUT, and a
//     whole-process-TREE kill (detached process group on POSIX, taskkill /T on
//     Windows) so a hanging or forking test can't linger.
//   - Generated file paths are confined to the sandbox (no absolute paths, no
//     '..' escapes).
//   - Network is NOT sandboxed — documented; auto-run is confined to temp.
//   - Nothing is ever run as admin/sudo.

import { spawn } from 'child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { dirname, isAbsolute, join, normalize } from 'path'

export type Framework = 'pytest' | 'jest' | 'vitest' | 'npm-test' | 'unknown'

export interface GitHubRepoRef {
  owner: string
  repo: string
  cloneUrl: string
  label: string
}

export interface Detection {
  framework: Framework
  testCommand: string
  /** Install command to run in the sandbox first; '' = nothing to install. */
  installCommand: string
  /** The lockfile that drove the install choice, or ''. */
  lockfile: string
  /** Default path for the generated test file, relative to the repo root. */
  suggestedTestPath: string
  note?: string
}

export interface GeneratedFile {
  path: string
  content: string
}

export type RunStatus =
  | 'passed'
  | 'failed'
  | 'error'
  | 'install-failed'
  | 'timeout'
  | 'aborted'
  | 'no-tests'

export interface RunInput {
  sandbox: string
  framework: Framework | string
  files: GeneratedFile[]
  testCommand: string
  installCommand?: string
  installDeps: boolean
  timeoutMs: number
  signal: AbortSignal
  onOutput: (chunk: string) => void
}

export interface RunMetrics {
  framework: Framework | string
  passed: number | null
  failed: number | null
  errored: number | null
  total: number | null
  durationMs: number
  exitCode: number | null
  status: RunStatus
  rawOutput: string
}

const DENYLIST = new Set([
  '.git',
  'node_modules',
  'dist',
  'out',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  'coverage',
  '.next',
  '.cache',
  '.DS_Store'
])

const RAW_OUTPUT_CAP = 60_000
const AKORITH_VITEST_CONFIG = 'akorith.vitest.config.mjs'

export function parseGitHubRepoUrl(input: string): GitHubRepoRef | null {
  const raw = input.trim()
  if (!raw || /[\0\r\n]/.test(raw)) return null

  const ssh = raw.match(/^git@github\.com:([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/)
  if (ssh) {
    return {
      owner: ssh[1],
      repo: ssh[2],
      cloneUrl: `https://github.com/${ssh[1]}/${ssh[2]}.git`,
      label: `${ssh[1]}/${ssh[2]}`
    }
  }

  const candidate = raw.startsWith('github.com/') ? `https://${raw}` : raw
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') return null
  const [owner, repoPart] = url.pathname.split('/').filter(Boolean)
  if (!owner || !repoPart) return null
  const repo = repoPart.replace(/\.git$/i, '')
  if (!/^[A-Za-z0-9-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) return null
  return {
    owner,
    repo,
    cloneUrl: `https://github.com/${owner}/${repo}.git`,
    label: `${owner}/${repo}`
  }
}

interface ExecResult {
  code: number | null
  stdout: string
}

/** Lightweight git read (returns '' on any failure). Never mutates the repo. */
function gitRead(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, shell: false })
    let out = ''
    child.stdout.on('data', (b: Buffer) => (out += b.toString('utf8')))
    child.on('error', () => resolve(''))
    child.on('close', (code) => resolve(code === 0 ? out : ''))
  })
}

// ---------------------------------------------------------------- detection

export async function detectFramework(sourceRepo: string): Promise<Detection> {
  const has = (f: string): boolean => existsSync(join(sourceRepo, f))
  const read = (f: string): string => {
    try {
      return readFileSync(join(sourceRepo, f), 'utf8')
    } catch {
      return ''
    }
  }

  // ---- JS / TS first (package.json is the strongest signal) ----
  if (has('package.json')) {
    let pkg: { scripts?: Record<string, string>; devDependencies?: Record<string, string>; dependencies?: Record<string, string> } = {}
    try {
      pkg = JSON.parse(read('package.json'))
    } catch {
      /* fall through with empty pkg */
    }
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
    const lockfile = has('pnpm-lock.yaml')
      ? 'pnpm-lock.yaml'
      : has('yarn.lock')
        ? 'yarn.lock'
        : has('package-lock.json')
          ? 'package-lock.json'
          : ''
    const install = lockfile === 'pnpm-lock.yaml'
      ? 'pnpm install --frozen-lockfile'
      : lockfile === 'yarn.lock'
        ? 'yarn install --frozen-lockfile'
        : lockfile === 'package-lock.json'
          ? 'npm ci'
          : ''
    const isTs = has('tsconfig.json')
    const suggestedTestPath = `loopex_generated.test.${isTs ? 'ts' : 'js'}`

    if (deps.vitest) {
      return { framework: 'vitest', testCommand: `npx vitest run ${suggestedTestPath}`, installCommand: install, lockfile, suggestedTestPath }
    }
    if (deps.jest) {
      return { framework: 'jest', testCommand: `npx jest ${suggestedTestPath}`, installCommand: install, lockfile, suggestedTestPath }
    }
    if (pkg.scripts?.test && !/no test specified/i.test(pkg.scripts.test)) {
      return { framework: 'npm-test', testCommand: 'npm test', installCommand: install, lockfile, suggestedTestPath }
    }

    const hasUiDeps = Boolean(deps.react || deps.next || deps.vite || deps['@vitejs/plugin-react'])
    const fallbackTestPath = `akorith.generated.test.${isTs ? (hasUiDeps ? 'tsx' : 'ts') : 'js'}`
    return {
      framework: 'vitest',
      testCommand: `npx --yes vitest run --config ${AKORITH_VITEST_CONFIG} ${fallbackTestPath}`,
      installCommand: install || 'npm install',
      lockfile,
      suggestedTestPath: fallbackTestPath,
      note: 'No existing test runner was detected; using a temporary Vitest fallback.'
    }
  }

  // ---- Python ----
  const pyproject = read('pyproject.toml')
  const requirements = read('requirements.txt')
  // A bare `tests/` dir is NOT enough — JS repos (Playwright/Cypress e2e) have one
  // too. Require actual Python evidence so we don't mis-detect a JS repo as pytest.
  const hasPyFiles = (dir: string): boolean => {
    try {
      return readdirSync(join(sourceRepo, dir)).some((f) => f.endsWith('.py'))
    } catch {
      return false
    }
  }
  const pythonEvidence =
    has('pyproject.toml') || has('requirements.txt') || has('setup.py') || has('setup.cfg') || hasPyFiles('.')
  const looksPytest =
    pythonEvidence &&
    (has('pytest.ini') ||
      has('tox.ini') ||
      /\[tool\.pytest/.test(pyproject) ||
      /pytest/.test(requirements) ||
      /pytest/.test(pyproject) ||
      has('tests') ||
      has('test') ||
      hasPyFiles('.') ||
      hasPyFiles('tests') ||
      hasPyFiles('src'))
  if (looksPytest) {
    const lockfile = has('requirements.txt') ? 'requirements.txt' : has('poetry.lock') ? 'poetry.lock' : ''
    const installCommand = has('requirements.txt')
      ? 'python3 -m pip install -r requirements.txt'
      : has('poetry.lock')
        ? 'poetry install'
        : ''
    return {
      framework: 'pytest',
      testCommand: 'python3 -m pytest -q tests/test_loopex_generated.py',
      installCommand,
      lockfile,
      suggestedTestPath: 'tests/test_loopex_generated.py'
    }
  }

  // No JS/TS toolchain and no Python evidence: rather than block the benchmark,
  // fall back to Akorith's own disposable Vitest sandbox so Detect → Generate →
  // Run → Score always continues. The model is asked to write a self-contained
  // test; the runner brings its own config and needs nothing from the repo.
  return {
    framework: 'vitest',
    testCommand: `npx --yes vitest run --config ${AKORITH_VITEST_CONFIG} akorith.generated.test.ts`,
    installCommand: 'npm install',
    lockfile: '',
    suggestedTestPath: 'akorith.generated.test.ts',
    note: 'No standard test runner found — using Akorith’s own sandbox evaluation.'
  }
}

// ---------------------------------------------------------------- repo context

const SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.go', '.java'
])
// Files we never want the generator to "test" directly or treat as source.
const CONTEXT_SKIP_DIR = new Set([...DENYLIST, 'tests', 'test', '__tests__', 'e2e', 'public', 'assets', 'build', 'docs'])

interface RepoContextFile {
  path: string
  bytes: number
}

export interface RepoContext {
  tree: string
  /** A few small, importable source files with their content, for accurate imports. */
  samples: { path: string; content: string }[]
  fileCount: number
}

/** Recursively collect source files (bounded), skipping heavy/irrelevant dirs. */
function collectSourceFiles(root: string, rel = '', out: RepoContextFile[] = [], depth = 0): RepoContextFile[] {
  if (depth > 6 || out.length > 400) return out
  let entries: string[]
  try {
    entries = readdirSync(join(root, rel))
  } catch {
    return out
  }
  for (const name of entries) {
    if (name.startsWith('.') && name !== '.') continue
    const childRel = rel ? `${rel}/${name}` : name
    const full = join(root, childRel)
    let isDir = false
    try {
      isDir = statSync(full).isDirectory()
    } catch {
      continue
    }
    if (isDir) {
      if (CONTEXT_SKIP_DIR.has(name)) continue
      collectSourceFiles(root, childRel, out, depth + 1)
    } else {
      const dot = name.lastIndexOf('.')
      const ext = dot >= 0 ? name.slice(dot) : ''
      if (!SOURCE_EXTS.has(ext)) continue
      if (/\.(d\.ts|test\.|spec\.)/.test(name)) continue
      let bytes = 0
      try {
        bytes = statSync(full).size
      } catch {
        continue
      }
      out.push({ path: childRel, bytes })
    }
  }
  return out
}

/**
 * Build a bounded, read-only context describing the repo's source files so the
 * test generator imports REAL modules with REAL exported names instead of
 * guessing. Picks the smallest non-trivial source files as concrete samples.
 */
export function buildRepoContext(sourceRepo: string, opts: { maxSamples?: number; maxSampleBytes?: number } = {}): RepoContext {
  const maxSamples = opts.maxSamples ?? 4
  const maxSampleBytes = opts.maxSampleBytes ?? 6000
  const files = collectSourceFiles(sourceRepo)
  const tree = files
    .map((f) => f.path)
    .sort()
    .slice(0, 200)
    .join('\n')

  // Prefer small but non-trivial files (likely pure utilities → easiest to test).
  const candidates = files
    .filter((f) => f.bytes >= 80 && f.bytes <= maxSampleBytes)
    .sort((a, b) => a.bytes - b.bytes)
    .slice(0, maxSamples)

  const samples: { path: string; content: string }[] = []
  for (const f of candidates) {
    try {
      let content = readFileSync(join(sourceRepo, f.path), 'utf8')
      if (content.length > maxSampleBytes) content = content.slice(0, maxSampleBytes) + '\n// … [truncated]'
      samples.push({ path: f.path, content })
    } catch {
      /* skip unreadable */
    }
  }
  return { tree, samples, fileCount: files.length }
}

// ---------------------------------------------------------------- snapshot

/**
 * Copy the source repo into the sandbox WITHOUT touching the source. For a git
 * repo we copy exactly the tracked + untracked-not-ignored files (current
 * working state, .gitignore respected, heavy dirs excluded). Otherwise a
 * recursive copy minus a denylist.
 */
export async function snapshotSource(
  sourceRepo: string,
  sandbox: string
): Promise<{ files: number; mode: 'git' | 'copy' }> {
  const isGit = (await gitRead(sourceRepo, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true'

  if (isGit) {
    const [tracked, untracked] = await Promise.all([
      gitRead(sourceRepo, ['ls-files', '-z']),
      gitRead(sourceRepo, ['ls-files', '--others', '--exclude-standard', '-z'])
    ])
    const rel = [...tracked.split('\0'), ...untracked.split('\0')].map((s) => s.trim()).filter(Boolean)
    let files = 0
    for (const r of rel) {
      const from = join(sourceRepo, r)
      const to = join(sandbox, r)
      if (!existsSync(from)) continue
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(from, to)
      files++
    }
    return { files, mode: 'git' }
  }

  let files = 0
  cpSync(sourceRepo, sandbox, {
    recursive: true,
    filter: (src) => {
      // src is an absolute path under sourceRepo; reject any denylisted segment.
      const segs = normalize(src).split(/[\\/]/)
      if (segs.some((s) => DENYLIST.has(s))) return false
      files++
      return true
    }
  })
  return { files, mode: 'copy' }
}

// ---------------------------------------------------------------- run

/** Reject anything that could escape the sandbox. */
function safeRelative(p: string): boolean {
  if (!p || isAbsolute(p)) return false
  const norm = normalize(p)
  return !norm.startsWith('..') && !norm.split(/[\\/]/).includes('..')
}

interface BoundedResult {
  code: number | null
  output: string
  timedOut: boolean
  aborted: boolean
}

/** Run one shell command bounded by timeout + abort, killing the whole tree. */
function runBounded(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
  onOutput: (chunk: string) => void
): Promise<BoundedResult> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32'
    const child = spawn(command, {
      cwd,
      shell: true,
      env: process.env,
      // A new process group on POSIX so we can kill children too.
      detached: !isWin
    })

    let output = ''
    let timedOut = false
    let aborted = false
    let settled = false

    const capture = (b: Buffer): void => {
      const s = b.toString('utf8')
      if (output.length < RAW_OUTPUT_CAP) output += s
      onOutput(s)
    }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)

    const killTree = (): void => {
      if (child.pid === undefined) return
      if (isWin) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'])
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL') // negative pid → the whole group
        } catch {
          try {
            child.kill('SIGKILL')
          } catch {
            /* already gone */
          }
        }
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      onOutput(`\r\n\x1b[33m[loopex] timed out after ${timeoutMs}ms — killing process tree\x1b[0m\r\n`)
      killTree()
    }, timeoutMs)

    const onAbort = (): void => {
      aborted = true
      onOutput('\r\n\x1b[33m[loopex] stopped by user — killing process tree\x1b[0m\r\n')
      killTree()
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })

    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve({ code, output, timedOut, aborted })
    }

    child.on('error', (err) => {
      onOutput(`\r\n\x1b[31m[loopex] failed to launch: ${err.message}\x1b[0m\r\n`)
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })
}

/**
 * Write the generated files into the sandbox, optionally install deps, then run
 * the test command. All confined to the sandbox; parses objective metrics.
 */
export async function runTests(input: RunInput): Promise<RunMetrics> {
  const started = Date.now()

  // 1. Write generated test files (sandbox-confined).
  for (const f of input.files) {
    if (!safeRelative(f.path)) {
      return failMetrics(input.framework, started, 'error', `unsafe generated file path: ${f.path}`, input.onOutput)
    }
    const dest = join(input.sandbox, f.path)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, f.content, 'utf8')
    input.onOutput(`\x1b[90m[loopex] wrote ${f.path}\x1b[0m\r\n`)
  }

  if ((input.framework || '').toLowerCase() === 'vitest' && input.testCommand.includes(AKORITH_VITEST_CONFIG)) {
    const configPath = join(input.sandbox, AKORITH_VITEST_CONFIG)
    if (!existsSync(configPath)) {
      writeFileSync(
        configPath,
        [
          "import { fileURLToPath } from 'node:url'",
          "import { dirname, resolve } from 'node:path'",
          '',
          'const root = dirname(fileURLToPath(import.meta.url))',
          '',
          'export default {',
          "  resolve: { alias: { '@': root, '~': root } },",
          "  test: { environment: 'node', globals: false, passWithNoTests: false }",
          '}',
          ''
        ].join('\n'),
        'utf8'
      )
      input.onOutput(`\x1b[90m[loopex] wrote ${AKORITH_VITEST_CONFIG}\x1b[0m\r\n`)
    }
  }

  // 2. Install dependencies (failure is its own status, not a test failure).
  if (input.installDeps && input.installCommand && input.installCommand.trim()) {
    input.onOutput(`\r\n\x1b[36m$ ${input.installCommand}\x1b[0m\r\n`)
    const inst = await runBounded(input.installCommand, input.sandbox, input.timeoutMs, input.signal, input.onOutput)
    if (inst.aborted) return failMetrics(input.framework, started, 'aborted', '', input.onOutput, inst.output)
    if (inst.timedOut) return failMetrics(input.framework, started, 'timeout', '', input.onOutput, inst.output)
    if (inst.code !== 0) {
      return {
        framework: input.framework,
        passed: null,
        failed: null,
        errored: null,
        total: null,
        durationMs: Date.now() - started,
        exitCode: inst.code,
        status: 'install-failed',
        rawOutput: inst.output
      }
    }
  }

  // 3. Run the tests.
  input.onOutput(`\r\n\x1b[36m$ ${input.testCommand}\x1b[0m\r\n`)
  const res = await runBounded(input.testCommand, input.sandbox, input.timeoutMs, input.signal, input.onOutput)

  if (res.aborted) return failMetrics(input.framework, started, 'aborted', '', input.onOutput, res.output)
  if (res.timedOut) return failMetrics(input.framework, started, 'timeout', '', input.onOutput, res.output)

  const counts = parseMetrics(input.framework, res.output)
  const total = counts.total
  const status: RunStatus =
    res.code === 0
      ? total && total > 0
        ? 'passed'
        : 'no-tests'
      : (counts.failed ?? 0) > 0
        ? 'failed'
        : 'error'

  return {
    framework: input.framework,
    passed: counts.passed,
    failed: counts.failed,
    errored: counts.errored,
    total,
    durationMs: Date.now() - started,
    exitCode: res.code,
    status,
    rawOutput: res.output
  }
}

function failMetrics(
  framework: Framework | string,
  started: number,
  status: RunStatus,
  message: string,
  onOutput: (c: string) => void,
  rawOutput = ''
): RunMetrics {
  if (message) onOutput(`\r\n\x1b[31m[loopex] ${message}\x1b[0m\r\n`)
  return {
    framework,
    passed: null,
    failed: null,
    errored: null,
    total: null,
    durationMs: Date.now() - started,
    exitCode: null,
    status,
    rawOutput: rawOutput || message
  }
}

// ---------------------------------------------------------------- parsing

interface Counts {
  passed: number | null
  failed: number | null
  errored: number | null
  total: number | null
}

/** Best-effort, framework-aware parse of pass/fail/error counts from output. */
export function parseMetrics(framework: Framework | string, output: string): Counts {
  const num = (re: RegExp): number | null => {
    const m = output.match(re)
    return m ? parseInt(m[1], 10) : null
  }

  if (framework === 'pytest') {
    const passed = num(/(\d+) passed/)
    const failed = num(/(\d+) failed/)
    const errored = num(/(\d+) error/)
    if (passed === null && failed === null && errored === null) return emptyCounts()
    const total = (passed ?? 0) + (failed ?? 0) + (errored ?? 0)
    return { passed: passed ?? 0, failed: failed ?? 0, errored: errored ?? 0, total }
  }

  if (framework === 'jest' || framework === 'vitest' || framework === 'npm-test') {
    // jest:   "Tests:  1 failed, 2 passed, 3 total"
    // vitest: "Tests  1 failed | 2 passed (3)"
    const passed = num(/(\d+) passed/)
    const failed = num(/(\d+) failed/)
    const total = num(/(\d+) total/) ?? num(/\((\d+)\)\s*$/m)
    if (passed === null && failed === null && total === null) return emptyCounts()
    const t = total ?? (passed ?? 0) + (failed ?? 0)
    return { passed: passed ?? 0, failed: failed ?? 0, errored: 0, total: t }
  }

  // Unknown framework: try every pattern; otherwise leave nulls (exit code rules).
  const passed = num(/(\d+) passed/)
  const failed = num(/(\d+) failed/)
  const errored = num(/(\d+) error/)
  if (passed === null && failed === null && errored === null) return emptyCounts()
  return {
    passed: passed ?? 0,
    failed: failed ?? 0,
    errored: errored ?? 0,
    total: (passed ?? 0) + (failed ?? 0) + (errored ?? 0)
  }
}

function emptyCounts(): Counts {
  return { passed: null, failed: null, errored: null, total: null }
}

// ---------------------------------------------------------------- cleanup

/** Keep only the newest `keepLastN` sandbox dirs under `base`; delete the rest. */
export function pruneSandboxes(base: string, keepLastN: number): void {
  if (!existsSync(base)) return
  let entries: { name: string; mtime: number }[]
  try {
    entries = readdirSync(base).map((name: string) => {
      try {
        return { name, mtime: statSync(join(base, name)).mtimeMs }
      } catch {
        return { name, mtime: 0 }
      }
    })
  } catch {
    return
  }
  entries.sort((a, b) => b.mtime - a.mtime)
  for (const e of entries.slice(Math.max(keepLastN, 0))) {
    try {
      rmSync(join(base, e.name), { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
}

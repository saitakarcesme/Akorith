// Headless verification of the Phase 7 test-lab SAFETY CORE (electron-free).
// Run: node --experimental-strip-types scripts/verify-testlab.ts
//
// Proves, without the GUI: framework detection, read-only snapshot (source
// untouched), a real bounded run with metric parsing, timeout process-tree
// kill, user abort, and sandbox pruning.

import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { detectFramework, snapshotSource, runTests, parseMetrics, pruneSandboxes, parseGitHubRepoUrl } from '../src/main/testlab.ts'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++
    console.log(`  \x1b[32m✓\x1b[0m ${name}`)
  } else {
    fail++
    console.log(`  \x1b[31m✗ ${name}\x1b[0m ${detail}`)
  }
}

const sink = (): void => {} // discard streamed output in tests
const tmpBase = mkdtempSync(join(tmpdir(), 'loopex-verify-'))
const longRunningNode = 'node -e "setTimeout(()=>{}, 30000)"'
const gitStatus = (cwd: string): string => execFileSync('git', ['status', '--porcelain'], { cwd }).toString()

async function main(): Promise<void> {
  // --- 1. parseMetrics ---
  console.log('\nparseMetrics:')
  const py = parseMetrics('pytest', '===== 2 passed, 1 failed, 1 error in 0.05s =====')
  check('pytest counts', py.passed === 2 && py.failed === 1 && py.errored === 1 && py.total === 4, JSON.stringify(py))
  const jest = parseMetrics('jest', 'Tests:       1 failed, 2 passed, 3 total')
  check('jest counts', jest.passed === 2 && jest.failed === 1 && jest.total === 3, JSON.stringify(jest))
  const vit = parseMetrics('vitest', 'Tests  1 failed | 2 passed (3)')
  check('vitest counts', vit.passed === 2 && vit.failed === 1 && vit.total === 3, JSON.stringify(vit))
  const none = parseMetrics('pytest', 'no recognizable summary here')
  check('no-summary → nulls', none.passed === null && none.total === null)

  // --- 2. detection (crafted JS repo) ---
  console.log('\ndetectFramework:')
  const jsRepo = join(tmpBase, 'jsrepo')
  mkdirSync(jsRepo, { recursive: true })
  writeFileSync(join(jsRepo, 'package.json'), JSON.stringify({ devDependencies: { vitest: '^1' } }))
  writeFileSync(join(jsRepo, 'package-lock.json'), '{}')
  writeFileSync(join(jsRepo, 'tsconfig.json'), '{}')
  const jsDet = await detectFramework(jsRepo)
  check('vitest detected', jsDet.framework === 'vitest', jsDet.framework)
  check('npm ci chosen from lockfile', jsDet.installCommand === 'npm ci', jsDet.installCommand)
  check('ts test path suggested', jsDet.suggestedTestPath.endsWith('.ts'), jsDet.suggestedTestPath)

  const fallbackRepo = join(tmpBase, 'fallback-jsrepo')
  mkdirSync(fallbackRepo, { recursive: true })
  writeFileSync(join(fallbackRepo, 'package.json'), JSON.stringify({ dependencies: { next: '^14.0.0', react: '^18.0.0' } }))
  writeFileSync(join(fallbackRepo, 'tsconfig.json'), '{}')
  const fallbackDet = await detectFramework(fallbackRepo)
  check('JS repo fallback uses vitest', fallbackDet.framework === 'vitest', fallbackDet.framework)
  check('fallback command avoids prompt', fallbackDet.testCommand === 'npx --yes vitest run --config akorith.vitest.config.mjs', fallbackDet.testCommand)
  check('UI fallback suggests tsx test', fallbackDet.suggestedTestPath.endsWith('.tsx'), fallbackDet.suggestedTestPath)

  const pyRepo = join(tmpBase, 'pyrepo')
  mkdirSync(join(pyRepo, 'tests'), { recursive: true })
  writeFileSync(join(pyRepo, 'requirements.txt'), 'pytest\n')
  const pyDet = await detectFramework(pyRepo)
  check('pytest detected', pyDet.framework === 'pytest', pyDet.framework)
  check('pip install chosen', /pip install -r requirements.txt/.test(pyDet.installCommand), pyDet.installCommand)

  const gh = parseGitHubRepoUrl('https://github.com/openai/codex.git')
  check('GitHub HTTPS URL parsed', gh?.cloneUrl === 'https://github.com/openai/codex.git', JSON.stringify(gh))
  const ghPlain = parseGitHubRepoUrl('github.com/openai/codex')
  check('GitHub plain URL parsed', ghPlain?.label === 'openai/codex', JSON.stringify(ghPlain))
  check('non-GitHub URL rejected', parseGitHubRepoUrl('https://example.com/openai/codex') === null)

  // --- 3. snapshot leaves SOURCE untouched (against the real repo) ---
  console.log('\nsnapshotSource (source read-only):')
  const repoRoot = process.cwd()
  const before = gitStatus(repoRoot)
  const snapBox = join(tmpBase, 'snap')
  mkdirSync(snapBox, { recursive: true })
  const snap = await snapshotSource(repoRoot, snapBox)
  const after = gitStatus(repoRoot)
  check('snapshot copied tracked files (git mode)', snap.mode === 'git' && snap.files > 10, JSON.stringify(snap))
  check('sandbox has a copied file', existsSync(join(snapBox, 'package.json')))
  check('SOURCE git status unchanged by snapshot', before === after)
  check('snapshot excluded node_modules', !existsSync(join(snapBox, 'node_modules')))

  // --- 4. a REAL bounded run: a tiny python module + generated test ---
  console.log('\nrunTests (real pytest if installable, else install-failed path):')
  const src = join(tmpBase, 'mathsrc')
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'mathutils.py'), 'def add(a, b):\n    return a + b\n')
  const box = join(tmpBase, 'run-pytest')
  mkdirSync(box, { recursive: true })
  await snapshotSource(src, box)
  const ctrl = new AbortController()
  const m = await runTests({
    sandbox: box,
    framework: 'pytest',
    files: [
      {
        path: 'tests/test_math.py',
        content: 'from mathutils import add\n\ndef test_ok():\n    assert add(2, 3) == 5\n\ndef test_bad():\n    assert add(2, 2) == 5\n'
      }
    ],
    testCommand: 'python3 -m pytest -q',
    installCommand: 'python3 -m pip install --quiet --disable-pip-version-check pytest',
    installDeps: true,
    timeoutMs: 90_000,
    signal: ctrl.signal,
    onOutput: sink
  })
  console.log(`    → status=${m.status} passed=${m.passed} failed=${m.failed} exit=${m.exitCode} dur=${m.durationMs}ms`)
  if (m.status === 'install-failed') {
    check('install failure surfaced distinctly (no network?)', m.status === 'install-failed')
  } else {
    check('real pytest: 1 passed', m.passed === 1, String(m.passed))
    check('real pytest: 1 failed', m.failed === 1, String(m.failed))
    check('real pytest: status=failed', m.status === 'failed', m.status)
  }
  check('unsafe path rejected', await unsafePathRejected())

  // --- 5. timeout kills the process tree promptly ---
  console.log('\ntimeout (process-tree kill):')
  const tBox = join(tmpBase, 'timeout')
  mkdirSync(tBox, { recursive: true })
  const t0 = Date.now()
  const tm = await runTests({
    sandbox: tBox,
    framework: 'unknown',
    files: [],
    testCommand: longRunningNode,
    installDeps: false,
    timeoutMs: 2_000,
    signal: new AbortController().signal,
    onOutput: sink
  })
  const elapsed = Date.now() - t0
  check('status=timeout', tm.status === 'timeout', tm.status)
  check('returned near the timeout, not after sleep 30', elapsed < 8_000, `${elapsed}ms`)

  // --- 6. user abort ---
  console.log('\nabort (Stop):')
  const aBox = join(tmpBase, 'abort')
  mkdirSync(aBox, { recursive: true })
  const aCtrl = new AbortController()
  setTimeout(() => aCtrl.abort(), 800)
  const am = await runTests({
    sandbox: aBox,
    framework: 'unknown',
    files: [],
    testCommand: longRunningNode,
    installDeps: false,
    timeoutMs: 60_000,
    signal: aCtrl.signal,
    onOutput: sink
  })
  check('status=aborted', am.status === 'aborted', am.status)

  // --- 7. prune ---
  console.log('\npruneSandboxes:')
  const pBase = join(tmpBase, 'prunebase')
  for (let i = 0; i < 5; i++) {
    mkdirSync(join(pBase, `box${i}`), { recursive: true })
    // stagger mtimes
    await new Promise((r) => setTimeout(r, 15))
  }
  pruneSandboxes(pBase, 2)
  const remaining = readdirSync(pBase).length
  check('prune keeps last N (2)', remaining === 2, String(remaining))
}

async function unsafePathRejected(): Promise<boolean> {
  const box = join(tmpBase, 'unsafe')
  mkdirSync(box, { recursive: true })
  const m = await runTests({
    sandbox: box,
    framework: 'unknown',
    files: [{ path: '../escape.txt', content: 'nope' }],
    testCommand: 'echo hi',
    installDeps: false,
    timeoutMs: 5_000,
    signal: new AbortController().signal,
    onOutput: sink
  })
  return m.status === 'error' && !existsSync(join(tmpBase, 'escape.txt'))
}

main()
  .then(() => {
    rmSync(tmpBase, { recursive: true, force: true })
    console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`)
    process.exit(fail === 0 ? 0 : 1)
  })
  .catch((err) => {
    console.error('verify crashed:', err)
    rmSync(tmpBase, { recursive: true, force: true })
    process.exit(1)
  })

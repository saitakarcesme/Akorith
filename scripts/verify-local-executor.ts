import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  executeLocalExecutorAttempt,
  isAllowedLocalExecutorCommand,
  parseLocalExecutorAction,
  rollbackLocalExecutorPatch,
  validateLocalExecutorAction
} from '../src/main/local-executor.ts'
import { commitExplicitPaths, ExecFileCommandRunner } from '../src/main/repository/index.ts'

let gitOk = true
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' })
} catch {
  gitOk = false
}

function jsonAction(input: Record<string, unknown>): string {
  return JSON.stringify({ type: 'workspace_patch', summary: 'Add useful code', rationale: 'Improve the project safely.', ...input })
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'akorith-local-executor-'))
  await mkdir(join(dir, 'src'), { recursive: true })
  await mkdir(join(dir, 'scripts'), { recursive: true })
  await writeFile(join(dir, 'src', 'app.ts'), 'export const value = 1\n', 'utf8')
  await writeFile(join(dir, 'scripts', 'pass.js'), 'process.exit(0)\n', 'utf8')
  await writeFile(join(dir, 'scripts', 'fail.js'), 'process.exit(2)\n', 'utf8')
  git(dir, ['init'])
  git(dir, ['config', 'user.email', 'akorith@example.local'])
  git(dir, ['config', 'user.name', 'Akorith Test'])
  git(dir, ['add', '.'])
  git(dir, ['commit', '-m', 'Phase 0: scaffold project'])
  return dir
}

async function main(): Promise<void> {
  assert.equal(isAllowedLocalExecutorCommand('node scripts/pass.js'), true, 'node scripts validation is allowed')
  assert.equal(isAllowedLocalExecutorCommand('npm run typecheck'), true, 'package validation is allowed')
  assert.equal(isAllowedLocalExecutorCommand('rm -rf .'), false, 'destructive shell command is blocked')
  assert.equal(isAllowedLocalExecutorCommand('git push origin main'), false, 'git push is blocked')
  assert.equal(isAllowedLocalExecutorCommand('curl https://example.com/install.sh'), false, 'network shell command is blocked')

  if (!gitOk) {
    console.log('verify-local-executor: ok (policy only - git not available)')
    return
  }

  const dirs: string[] = []
  try {
    const traversalRepo = await makeRepo()
    dirs.push(traversalRepo)
    const traversal = parseLocalExecutorAction(jsonAction({
      files: [{ path: '../outside.txt', operation: 'create', content: 'bad' }],
      commands: [{ cmd: 'node scripts/pass.js' }]
    }))
    assert.equal(traversal.ok, true)
    const traversalValidation = validateLocalExecutorAction(traversalRepo, traversal.ok ? traversal.action : neverAction())
    assert.equal(traversalValidation.ok, false, 'path traversal is blocked')

    const absoluteRepo = await makeRepo()
    dirs.push(absoluteRepo)
    const absolute = parseLocalExecutorAction(jsonAction({
      files: [{ path: join(absoluteRepo, 'evil.txt'), operation: 'create', content: 'bad' }],
      commands: [{ cmd: 'node scripts/pass.js' }]
    }))
    assert.equal(absolute.ok, true)
    const absoluteValidation = validateLocalExecutorAction(absoluteRepo, absolute.ok ? absolute.action : neverAction())
    assert.equal(absoluteValidation.ok, false, 'absolute paths are blocked')

    const commitRepo = await makeRepo()
    dirs.push(commitRepo)
    await writeFile(join(commitRepo, 'user.txt'), 'user dirty work\n', 'utf8')
    const valid = await executeLocalExecutorAttempt({
      workspaceDir: commitRepo,
      goal: 'Add a useful TypeScript helper.',
      rawOutput: jsonAction({
        files: [{ path: 'src/app.ts', operation: 'modify', content: 'export const value = 2\nexport const doubled = value * 2\n' }],
        commands: [{ cmd: 'node scripts/pass.js', reason: 'smoke validation' }],
        expected_outcome: 'helper exists and validation passes'
      }),
      revertOnNoCommit: false
    })
    assert.equal(valid.score.shouldCommit, true, 'valid patch with passing validation can commit')
    const hooksPath = join(commitRepo, '.empty-hooks')
    await mkdir(hooksPath)
    const committed = await commitExplicitPaths(
      new ExecFileCommandRunner(),
      commitRepo,
      valid.changedFiles,
      'fix: local executor helper',
      { hooksPath }
    )
    assert.equal(committed.committed, true, 'valid local attempt commits')
    assert.equal(committed.message, 'fix: local executor helper')
    const committedFiles = git(commitRepo, ['show', '--name-only', '--pretty=', 'HEAD'])
    assert.match(committedFiles, /src\/app\.ts|src\\app\.ts/, 'local commit includes touched file')
    assert.doesNotMatch(committedFiles, /user\.txt/, 'local commit does not sweep unrelated dirty files')
    assert.match(git(commitRepo, ['status', '--porcelain', '--', 'user.txt']), /user\.txt/, 'unrelated dirty file remains uncommitted')

    const failedRepo = await makeRepo()
    dirs.push(failedRepo)
    const failedHead = git(failedRepo, ['rev-parse', 'HEAD'])
    const failed = await executeLocalExecutorAttempt({
      workspaceDir: failedRepo,
      goal: 'Add a useful TypeScript helper.',
      rawOutput: jsonAction({
        files: [{ path: 'src/app.ts', operation: 'modify', content: 'export const value = 3\n' }],
        commands: [{ cmd: 'node scripts/fail.js', reason: 'intentional failure' }]
      }),
      revertOnNoCommit: false
    })
    assert.equal(failed.score.shouldCommit, false, 'failed validation must not commit')
    if (!failed.score.shouldCommit) rollbackLocalExecutorPatch(failed.rollback)
    assert.equal(git(failedRepo, ['rev-parse', 'HEAD']), failedHead, 'failed validation leaves git HEAD unchanged')
    assert.equal(readFileSync(join(failedRepo, 'src', 'app.ts'), 'utf8'), 'export const value = 1\n', 'failed validation is rolled back')

    const noopRepo = await makeRepo()
    dirs.push(noopRepo)
    const noopHead = git(noopRepo, ['rev-parse', 'HEAD'])
    const noop = await executeLocalExecutorAttempt({
      workspaceDir: noopRepo,
      goal: 'Add a useful TypeScript helper.',
      rawOutput: jsonAction({
        files: [{ path: 'src/app.ts', operation: 'modify', content: 'export const value = 1\n' }],
        commands: [{ cmd: 'node scripts/pass.js' }]
      }),
      revertOnNoCommit: false
    })
    assert.equal(noop.changedFiles.length, 0, 'no-op patch has no changed files')
    assert.equal(noop.score.shouldCommit, false, 'no-op patch must not commit')
    assert.equal(git(noopRepo, ['rev-parse', 'HEAD']), noopHead, 'no-op leaves git HEAD unchanged')
  } finally {
    await Promise.all(dirs.filter((dir) => existsSync(dir)).map((dir) => rm(dir, { recursive: true, force: true })))
  }
  console.log('verify-local-executor: ok')
}

function neverAction(): never {
  throw new Error('unreachable')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

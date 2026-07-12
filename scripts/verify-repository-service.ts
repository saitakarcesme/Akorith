import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ExecFileCommandRunner,
  RepositoryError,
  RepositoryLeaseManager,
  RepositoryService,
  UnavailableGitHubRepositoryPluginAdapter,
  assertPathWithinRoot,
  classifyGitFailure,
  createLocalRepositoryRemote,
  parseGitHubRepositoryUrl,
  resolveRepositoryPath,
  type CommandResult,
  type GitHubRepositoryPluginAdapter
} from '../src/main/repository/index.ts'

let failures = 0

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures++
    console.log(`  FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_MERGE_AUTOEDIT: 'no' }
  }).trim()
}

function isCode(error: unknown, code: RepositoryError['code']): boolean {
  return error instanceof RepositoryError && error.code === code
}

async function main(): Promise<void> {
  execFileSync('git', ['--version'], { stdio: 'ignore' })
  const root = mkdtempSync(join(tmpdir(), 'akorith-repository-'))
  const managedRoot = join(root, 'managed')
  const bareRemote = join(root, 'primary.git')
  const otherBareRemote = join(root, 'other.git')
  mkdirSync(managedRoot, { recursive: true })
  git(root, ['init', '--bare', '-b', 'main', bareRemote])
  git(root, ['init', '--bare', '-b', 'main', otherBareRemote])

  const runner = new ExecFileCommandRunner()
  const service = new RepositoryService({ managedRoot, runner })
  let projectPath = ''
  let clonePath = ''

  try {
    await check('strict GitHub parser accepts canonical HTTPS and SSH forms', () => {
      const https = parseGitHubRepositoryUrl('https://github.com/OpenAI/example.git')
      const scp = parseGitHubRepositoryUrl('git@github.com:OpenAI/example.git')
      const ssh = parseGitHubRepositoryUrl('ssh://git@github.com/OpenAI/example.git')
      assert.equal(https.transport, 'https')
      assert.equal(scp.transport, 'ssh')
      assert.equal(ssh.transport, 'ssh')
      assert.equal(https.canonicalId, scp.canonicalId)
      assert.equal(scp.canonicalId, ssh.canonicalId)
      assert.equal(https.cloneUrl, 'https://github.com/OpenAI/example.git')
    })

    await check('strict GitHub parser rejects credentials, options, foreign hosts, and ambiguous paths', () => {
      const invalid = [
        'https://user:secret@github.com/owner/repo.git',
        'https://example.com/owner/repo.git',
        'http://github.com/owner/repo.git',
        'https://github.com/owner/repo/issues',
        'https://github.com/owner/repo.git?token=secret',
        'https://github.com/owner//repo.git',
        'git@github.com:owner/repo.git -oProxyCommand=evil',
        '--upload-pack=evil'
      ]
      for (const value of invalid) assert.throws(() => parseGitHubRepositoryUrl(value), (error) => isCode(error, 'invalid-url'))
    })

    await check('execFile runner rejects non-allowlisted executables and control-character arguments', async () => {
      await assert.rejects(
        runner.run({ executable: 'powershell', args: ['-Command', 'echo unsafe'], cwd: root }),
        /Executable is not allowed/
      )
      await assert.rejects(
        runner.run({ executable: 'git', args: ['status\n--porcelain'], cwd: root }),
        /invalid data/
      )
    })

    await check('new-project onboarding initializes identity, README, plan, and initial commit', async () => {
      const created = await service.createProject({
        name: 'Repository Foundation Fixture',
        summary: 'Offline fixture for the secure repository service verifier.',
        plan: '- Detect the project\n- Commit explicit files\n- Push to a local bare remote',
        identity: { name: 'Akorith Repository Test', email: 'repository@example.test' },
        branch: 'main'
      })
      projectPath = created.path
      assert.ok(existsSync(join(projectPath, 'README.md')))
      assert.ok(existsSync(join(projectPath, 'PLAN.md')))
      assert.match(created.initialCommitSha, /^[0-9a-f]{40}$/)
      assert.equal(git(projectPath, ['config', '--local', 'user.name']), 'Akorith Repository Test')
      assert.equal(git(projectPath, ['config', '--local', 'user.email']), 'repository@example.test')
      assert.deepEqual(git(projectPath, ['show', '--pretty=', '--name-only', 'HEAD']).split(/\r?\n/).sort(), ['PLAN.md', 'README.md'])
    })

    await check('canonical containment rejects traversal and symlink escapes', async () => {
      const outside = join(root, 'outside')
      mkdirSync(outside, { recursive: true })
      writeFileSync(join(outside, 'marker.txt'), 'outside')
      await assert.rejects(assertPathWithinRoot(managedRoot, outside, { mustExist: true }), (error) => isCode(error, 'outside-managed-root'))
      await assert.rejects(resolveRepositoryPath(projectPath, '../outside.txt'), (error) => isCode(error, 'invalid-pathspec'))

      const escape = join(projectPath, 'escape-link')
      symlinkSync(outside, escape, process.platform === 'win32' ? 'junction' : 'dir')
      try {
        await assert.rejects(resolveRepositoryPath(projectPath, 'escape-link/marker.txt'), (error) => isCode(error, 'invalid-pathspec'))
      } finally {
        unlinkSync(escape)
      }
    })

    await check('canonical leases conflict across lexical and symlink aliases', async () => {
      const alias = join(root, 'project-alias')
      symlinkSync(projectPath, alias, process.platform === 'win32' ? 'junction' : 'dir')
      const first = await service.leases.acquire(projectPath, { owner: 'first verifier lease' })
      try {
        await assert.rejects(
          service.leases.acquire(join(projectPath, '.'), { owner: 'lexical alias' }),
          (error) => isCode(error, 'lock-conflict')
        )
        await assert.rejects(
          service.leases.acquire(alias, { owner: 'symlink alias' }),
          (error) => isCode(error, 'lock-conflict')
        )
      } finally {
        await first.release()
        unlinkSync(alias)
      }
    })

    await check('expired lease is recoverable and old token cannot release the new lease', async () => {
      let now = 1_000
      const leases = new RepositoryLeaseManager(join(root, 'stale-locks'), { defaultTtlMs: 1_000, now: () => now })
      const first = await leases.acquire(projectPath, { owner: 'stale owner' })
      now = 2_100
      const replacement = await leases.acquire(projectPath, { owner: 'replacement owner' })
      await assert.rejects(first.release(), (error) => isCode(error, 'lock-lost'))
      await replacement.release()
    })

    await check('explicit-path commit preserves unrelated staged work and detects project tooling', async () => {
      mkdirSync(join(projectPath, 'src'), { recursive: true })
      writeFileSync(join(projectPath, 'src', 'index.ts'), 'export const answer: number = 42\n')
      writeFileSync(join(projectPath, 'package-lock.json'), '{"lockfileVersion":3}\n')
      writeFileSync(join(projectPath, 'package.json'), JSON.stringify({
        name: 'repository-fixture',
        private: true,
        scripts: {
          test: 'vitest run',
          build: 'tsc -p tsconfig.json',
          lint: 'eslint .',
          typecheck: 'tsc --noEmit'
        }
      }, null, 2))
      writeFileSync(join(projectPath, 'notes.txt'), 'unrelated staged user work\n')
      git(projectPath, ['add', '--', 'notes.txt'])

      const committed = await service.commit(
        projectPath,
        ['src/index.ts', 'package.json', 'package-lock.json'],
        'feat: detect TypeScript tooling; no shell interpolation'
      )
      assert.equal(committed.committed, true)
      const committedNames = git(projectPath, ['show', '--pretty=', '--name-only', 'HEAD']).split(/\r?\n/).filter(Boolean)
      assert.deepEqual(committedNames.sort(), ['package-lock.json', 'package.json', 'src/index.ts'])
      assert.equal(git(projectPath, ['diff', '--cached', '--name-only']), 'notes.txt')

      const inspection = await service.inspect(projectPath)
      assert.ok(inspection.technology.languages.includes('TypeScript'))
      assert.ok(inspection.technology.packageManagers.includes('npm'))
      assert.ok(inspection.technology.commands.test.some((entry) => entry.args.includes('test')))
      assert.ok(inspection.technology.commands.build.some((entry) => entry.args.includes('build')))
      assert.ok(inspection.technology.commands.lint.some((entry) => entry.args.includes('lint')))
      assert.ok(inspection.technology.commands.typecheck.some((entry) => entry.args.includes('typecheck')))
      await service.commit(projectPath, ['notes.txt'], 'docs: keep staged user notes explicit')
    })

    await check('dash-prefixed filenames remain data after the Git path separator', async () => {
      writeFileSync(join(projectPath, '--force'), 'this is a filename, not a Git option\n')
      const result = await service.commit(projectPath, ['--force'], 'test: commit a dash-prefixed filename')
      assert.equal(result.paths[0], '--force')
      assert.equal(git(projectPath, ['show', '--pretty=', '--name-only', 'HEAD']), '--force')
    })

    const primaryRemote = await createLocalRepositoryRemote(bareRemote)
    const secondaryRemote = await createLocalRepositoryRemote(otherBareRemote)

    await check('remote add/validation detects mismatches and supports explicit alternate remotes', async () => {
      await service.addRemote(projectPath, primaryRemote)
      await service.addRemote(projectPath, primaryRemote)
      await assert.rejects(service.addRemote(projectPath, secondaryRemote), (error) => isCode(error, 'remote-mismatch'))
      await service.addRemote(projectPath, secondaryRemote, { name: 'backup' })
      assert.equal(git(projectPath, ['remote', 'get-url', 'origin']), bareRemote)
      assert.equal(git(projectPath, ['remote', 'get-url', 'backup']), otherBareRemote)
    })

    await check('local bare remote reports default branch and dry-run push permission', async () => {
      const inspection = await service.inspectRemote(projectPath)
      assert.equal(inspection.reachable, true)
      assert.equal(inspection.defaultBranch, 'main')
      assert.equal(inspection.authState, 'not-required')
      assert.equal(inspection.canPush, true)
    })

    await check('non-force push creates the branch in a local bare remote', async () => {
      const pushed = await service.push(projectPath, { branch: 'main', setUpstream: true })
      assert.equal(pushed.pushed, true)
      assert.equal(git(root, ['--git-dir', bareRemote, 'rev-parse', 'refs/heads/main']), git(projectPath, ['rev-parse', 'HEAD']))
    })

    await check('managed clones are unique and preserve detected default branch', async () => {
      const first = await service.cloneRemote(primaryRemote)
      const second = await service.cloneRemote(primaryRemote)
      clonePath = first.path
      assert.notEqual(first.path, second.path)
      assert.equal(first.inspection.branch, 'main')
      assert.equal(first.inspection.defaultBranch, 'main')
      assert.ok(first.path.startsWith(managedRoot))
      assert.ok(second.path.startsWith(managedRoot))
    })

    await check('missing local remote is reported with a friendly structured code', async () => {
      const missing = join(root, 'missing.git')
      git(clonePath, ['remote', 'add', 'missing', missing])
      const inspected = await service.inspectRemote(clonePath, 'missing')
      assert.equal(inspected.reachable, false)
      assert.equal(inspected.repositoryExists, false)
      assert.equal(inspected.errorCode, 'remote-not-found')
    })

    await check('non-fast-forward push is blocked and merge conflicts are recoverable', async () => {
      writeFileSync(join(projectPath, 'src', 'index.ts'), 'export const answer: number = 43\n')
      await service.commit(projectPath, ['src/index.ts'], 'feat: update answer on main')
      await service.push(projectPath, { branch: 'main' })

      git(clonePath, ['config', '--local', 'user.name', 'Conflicting Clone'])
      git(clonePath, ['config', '--local', 'user.email', 'clone@example.test'])
      writeFileSync(join(clonePath, 'src', 'index.ts'), 'export const answer: number = 99\n')
      await service.commit(clonePath, ['src/index.ts'], 'feat: conflicting clone answer')
      await assert.rejects(service.push(clonePath, { branch: 'main' }), (error) => isCode(error, 'non-fast-forward'))

      git(clonePath, ['fetch', 'origin', 'main'])
      let conflicted = false
      try {
        git(clonePath, ['merge', 'origin/main'])
      } catch {
        conflicted = true
      }
      assert.equal(conflicted, true)
      const recovery = await service.inspectRecovery(clonePath)
      assert.equal(recovery.operation, 'merge')
      assert.deepEqual(recovery.conflicts, ['src/index.ts'])
      await assert.rejects(
        service.commit(clonePath, ['src/index.ts'], 'must not commit conflict'),
        (error) => isCode(error, 'merge-conflict')
      )
      const aborted = await service.abortRecovery(clonePath)
      assert.equal(aborted.operation, 'none')
      assert.deepEqual(aborted.conflicts, [])
    })

    await check('checkpoint restore changes only explicit tracked and untracked files', async () => {
      const checkpoint = await service.checkpoint(clonePath)
      const original = readFileSync(join(clonePath, 'src', 'index.ts'), 'utf8')
      writeFileSync(join(clonePath, 'src', 'index.ts'), 'temporary rollback content\n')
      writeFileSync(join(clonePath, 'scratch.txt'), 'temporary untracked file\n')
      const restored = await service.restore(clonePath, checkpoint, ['src/index.ts', 'scratch.txt'])
      assert.deepEqual(restored.sort(), ['scratch.txt', 'src/index.ts'])
      assert.equal(readFileSync(join(clonePath, 'src', 'index.ts'), 'utf8'), original)
      assert.equal(existsSync(join(clonePath, 'scratch.txt')), false)
    })

    await check('Git failure classifier distinguishes auth, not-found, permission, and non-fast-forward', () => {
      const result = (stderr: string): CommandResult => ({
        ok: false,
        exitCode: 128,
        signal: null,
        stdout: '',
        stderr,
        timedOut: false,
        cancelled: false,
        spawnError: false
      })
      assert.equal(classifyGitFailure(result('fatal: could not read Username: terminal prompts disabled'), 'read').code, 'authentication-required')
      assert.equal(classifyGitFailure(result('ERROR: Repository not found.'), 'read').code, 'remote-not-found')
      assert.equal(classifyGitFailure(result('remote: Permission to owner/repo denied'), 'push').code, 'push-permission-denied')
      assert.equal(classifyGitFailure(result('! [rejected] main -> main (non-fast-forward)'), 'push').code, 'non-fast-forward')
    })

    await check('GitHub creation seam is honestly auth-required while unavailable', async () => {
      await assert.rejects(
        service.createGitHubRepository({ owner: 'OpenAI', name: 'offline-fixture', description: '', visibility: 'private', initialize: false }),
        (error) => isCode(error, 'authentication-required')
      )
      const unavailableService = new RepositoryService({
        managedRoot,
        runner,
        githubAdapter: new UnavailableGitHubRepositoryPluginAdapter('Verifier is intentionally offline.')
      })
      await assert.rejects(
        unavailableService.createGitHubRepository({ owner: 'OpenAI', name: 'offline-fixture', description: '', visibility: 'private', initialize: false }),
        (error) => isCode(error, 'authentication-required')
      )
    })

    await check('typed GitHub adapter response is validated without a network call', async () => {
      const adapter: GitHubRepositoryPluginAdapter = {
        pluginId: 'github',
        availability: async () => ({ available: true, authenticated: true, reason: 'Offline verifier adapter.' }),
        createRepository: async (request) => ({
          owner: request.owner,
          name: request.name,
          httpsUrl: `https://github.com/${request.owner}/${request.name}`,
          defaultBranch: 'main'
        })
      }
      const adapterService = new RepositoryService({ managedRoot, runner, githubAdapter: adapter })
      const result = await adapterService.createGitHubRepository({
        owner: 'OpenAI',
        name: 'offline-fixture',
        description: 'No network call is made.',
        visibility: 'private',
        initialize: false
      })
      assert.equal(result.httpsUrl, 'https://github.com/OpenAI/offline-fixture')
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  if (failures > 0) {
    console.error(`\nverify-repository-service: ${failures} failed`)
    process.exit(1)
  }
  console.log('\nverify-repository-service: ok')
}

void main()

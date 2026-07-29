// Phase 48: verify the electron-free project-loop building blocks — the safe git
// helper (real git in a temp repo) and read-only project inspection. Does not
// require electron, the DB, or a live Ollama.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureRepo, isRepo, hasChanges, commitAll, currentSha } from '../src/main/project-loop/git.ts'
import { inspectProject, renderProjectContext } from '../src/main/project-loop/context.ts'
import { parseGitHubRepositoryUrl } from '../src/main/project-loop/github-url.ts'

let gitOk = true
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' })
} catch {
  gitOk = false
}

let failures = 0
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  ok   ${name}`)
  } catch (err) {
    failures++
    console.log(`  FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'akorith-loop-'))
  const outside = mkdtempSync(join(tmpdir(), 'akorith-loop-outside-'))
  // Configure a throwaway git identity so commits work in CI/sandboxes.
  if (gitOk) {
    try {
      execFileSync('git', ['-C', root, 'init', '-b', 'main'], { stdio: 'ignore' })
      execFileSync('git', ['-C', root, 'config', 'user.email', 'loop@akorith.local'], { stdio: 'ignore' })
      execFileSync('git', ['-C', root, 'config', 'user.name', 'Akorith Loop'], { stdio: 'ignore' })
    } catch {
      gitOk = false
    }
  }

  await check('inspectProject: empty dir', () => {
    const ctx = inspectProject(root)
    assert.equal(ctx.exists, true)
  })

  // Add some files + a key file.
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'index.ts'), 'export const x = 1\n')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo', version: '0.0.0' }))
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), '// huge dep')
  mkdirSync(join(root, 'dist'), { recursive: true })
  writeFileSync(join(root, 'dist', 'bundle.js'), '// generated output')
  writeFileSync(join(root, '.env'), 'SECRET_VALUE=must-not-leak')
  writeFileSync(join(root, 'credentials.json'), '{"token":"must-not-leak"}')
  writeFileSync(join(root, 'credentials.ts'), 'export const token = "credential-source-canary"')
  writeFileSync(join(root, 'secrets.py'), 'TOKEN = "python-secret-canary"')
  writeFileSync(join(root, 'secret.js'), 'export const token = "js-secret-canary"')
  writeFileSync(join(root, 'service-account-prod.ts'), 'export const token = "service-account-canary"')
  mkdirSync(join(root, 'secrets'), { recursive: true })
  writeFileSync(join(root, 'secrets', 'config.ts'), 'export const token = "secret-directory-canary"')

  const linkedKeyTarget = join(outside, 'outside-key.txt')
  const linkedSourceTarget = join(outside, 'outside-source.js')
  writeFileSync(linkedKeyTarget, 'linked-key-canary')
  writeFileSync(linkedSourceTarget, 'export const linked = "linked-source-canary"')
  const linkOrHardlink = (target: string, link: string): void => {
    try {
      symlinkSync(target, link, 'file')
    } catch {
      linkSync(target, link)
    }
  }
  linkOrHardlink(linkedKeyTarget, join(root, 'README.md'))
  linkOrHardlink(linkedSourceTarget, join(root, 'src', 'linked-source.js'))

  await check('inspectProject: lists source and excludes generated or secret paths', () => {
    const ctx = inspectProject(root)
    assert.ok(ctx.fileTree.some((f) => f.includes('src/index.ts')))
    assert.ok(!ctx.fileTree.some((f) => f.includes('node_modules')))
    assert.ok(!ctx.fileTree.some((f) => f.includes('dist/bundle.js')))
    assert.ok(!ctx.fileTree.some((f) => f.includes('.env')))
    assert.ok(!ctx.fileTree.some((f) => f.includes('credentials.json')))
    for (const secretPath of [
      'credentials.ts',
      'secrets.py',
      'secret.js',
      'service-account-prod.ts',
      'secrets/'
    ]) {
      assert.ok(!ctx.fileTree.some((file) => file.includes(secretPath)), `${secretPath} is excluded`)
    }
    assert.ok(ctx.keyFiles.some((k) => k.path === 'package.json'))
    assert.ok(!ctx.keyFiles.some((k) => k.path === 'README.md'), 'linked key files are excluded')
    assert.ok(ctx.sourceFiles.some((file) => file.path === 'src/index.ts'))
    assert.ok(
      !ctx.sourceFiles.some((file) => file.path === 'src/linked-source.js'),
      'linked source files are excluded'
    )
    assert.ok(ctx.sourceFiles.length <= 8)
    assert.ok(
      ctx.sourceFiles.reduce(
        (total, file) => total + Buffer.byteLength(file.excerpt, 'utf8'),
        0
      ) <= 16_000,
      'source excerpts stay inside the total context budget'
    )
  })

  await check('renderProjectContext: non-empty', () => {
    const text = renderProjectContext(inspectProject(root))
    assert.ok(text.includes('src/index.ts'))
    assert.ok(text.includes('Existing source excerpts (bounded):'))
    assert.ok(text.includes('export const x = 1'))
    assert.ok(!text.includes('must-not-leak'))
    for (const canary of [
      'credential-source-canary',
      'python-secret-canary',
      'js-secret-canary',
      'service-account-canary',
      'secret-directory-canary',
      'linked-key-canary',
      'linked-source-canary'
    ]) {
      assert.ok(!text.includes(canary), `${canary} never enters rendered context`)
    }
  })

  await check('GitHub URL: canonical https and SSH forms', () => {
    assert.deepEqual(parseGitHubRepositoryUrl('https://github.com/saitakarcesme/AkorithLoop.git'), {
      owner: 'saitakarcesme', name: 'AkorithLoop', slug: 'saitakarcesme/AkorithLoop', url: 'https://github.com/saitakarcesme/AkorithLoop'
    })
    assert.equal(parseGitHubRepositoryUrl('git@github.com:saitakarcesme/AkorithLoop.git').slug, 'saitakarcesme/AkorithLoop')
  })

  await check('GitHub URL: rejects files, credentials, hosts, and traversal', () => {
    for (const value of [
      'https://github.com/saitakarcesme/AkorithLoop/tree/main',
      'https://token@github.com/saitakarcesme/AkorithLoop',
      'https://gitlab.com/saitakarcesme/AkorithLoop',
      'https://github.com/../AkorithLoop'
    ]) assert.throws(() => parseGitHubRepositoryUrl(value))
  })

  if (gitOk) {
    await check('isRepo: true after init', async () => {
      assert.equal(await isRepo(root), true)
    })
    await check('hasChanges: true with new files', async () => {
      assert.equal(await hasChanges(root), true)
    })
    await check('ensureRepo: no-op on existing repo', async () => {
      await ensureRepo(root)
      assert.equal(await isRepo(root), true)
    })
    await check('commitAll: commits and returns sha', async () => {
      const res = await commitAll(root, 'feat: initial demo project')
      assert.equal(res.ok, true)
      assert.ok(res.sha && res.sha.length >= 7)
      assert.ok(res.filesChanged > 0)
    })
    await check('commitAll: nothing to commit after clean', async () => {
      const res = await commitAll(root, 'noop')
      assert.equal(res.ok, false)
    })
    await check('currentSha: present after commit', async () => {
      assert.ok((await currentSha(root))?.length)
    })
  } else {
    console.log('  skip git tests (git not available)')
  }

  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })

  if (failures > 0) {
    console.error(`\nverify-project-loop: ${failures} failed`)
    process.exit(1)
  }
  console.log('\nverify-project-loop: ok')
}

void main()

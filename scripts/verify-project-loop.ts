// Phase 48: verify the electron-free project-loop building blocks — the safe git
// helper (real git in a temp repo) and read-only project inspection. Does not
// require electron, the DB, or a live Ollama.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureRepo, isRepo, hasChanges, commitAll, currentSha } from '../src/main/project-loop/git.ts'
import { inspectProject, renderProjectContext } from '../src/main/project-loop/context.ts'

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

  await check('inspectProject: lists src, hides node_modules', () => {
    const ctx = inspectProject(root)
    assert.ok(ctx.fileTree.some((f) => f.includes('src/index.ts')))
    assert.ok(!ctx.fileTree.some((f) => f.includes('node_modules')))
    assert.ok(ctx.keyFiles.some((k) => k.path === 'package.json'))
  })

  await check('renderProjectContext: non-empty', () => {
    const text = renderProjectContext(inspectProject(root))
    assert.ok(text.includes('src/index.ts'))
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

  if (failures > 0) {
    console.error(`\nverify-project-loop: ${failures} failed`)
    process.exit(1)
  }
  console.log('\nverify-project-loop: ok')
}

void main()

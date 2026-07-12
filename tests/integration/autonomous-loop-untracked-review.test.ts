import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { changedFilesForValidation } from '../../src/main/autonomous-loop/commands'
import { inspectLoopDiff } from '../../src/main/autonomous-loop/reviewer'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Loop untracked-file evidence', () => {
  it('includes new files and their content in validation and deterministic review evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'akorith-untracked-review-'))
    roots.push(root)
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.email', 'loop@example.test'], { cwd: root })
    execFileSync('git', ['config', 'user.name', 'Loop Test'], { cwd: root })
    await writeFile(join(root, 'README.md'), '# Fixture\n', 'utf8')
    execFileSync('git', ['add', 'README.md'], { cwd: root })
    execFileSync('git', ['commit', '-m', 'Initial'], { cwd: root, stdio: 'ignore' })

    await mkdir(join(root, 'src', 'auth'), { recursive: true })
    await writeFile(
      join(root, 'src', 'auth', 'token.ts'),
      '// TODO: remove placeholder\nexport const leaked = "AKIAABCDEFGHIJKLMNOP"\n',
      'utf8'
    )

    const validationFiles = await changedFilesForValidation(root)
    const diff = await inspectLoopDiff(root)

    expect(validationFiles).toContain('src/auth/token.ts')
    expect(diff.changedFiles).toContain('src/auth/token.ts')
    expect(diff.addedDiff).toContain('TODO: remove placeholder')
    expect(diff.addedDiff).toContain('AKIAABCDEFGHIJKLMNOP')
  })
})

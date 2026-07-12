import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { observeRepository } from '../../src/main/autonomous-loop/observer'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('repository observer', () => {
  it('captures tracked and untracked source metadata without ignored output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'akorith-observer-'))
    roots.push(root)
    await mkdir(join(root, 'src', 'components'), { recursive: true })
    await mkdir(join(root, 'node_modules', 'ignored'), { recursive: true })
    await writeFile(join(root, '.gitignore'), 'node_modules/\n', 'utf8')
    await writeFile(join(root, 'README.md'), '# Fixture\nA small Electron application.\n', 'utf8')
    await writeFile(join(root, 'src', 'components', 'Button.tsx'), '// TODO: add keyboard test\nexport const Button = 1\n', 'utf8')
    await writeFile(join(root, 'src', 'untracked.ts'), 'export const untracked = true\n', 'utf8')
    await writeFile(join(root, 'node_modules', 'ignored', 'large.js'), 'ignored\n', 'utf8')
    await writeFile(join(root, 'package.json'), JSON.stringify({
      dependencies: { electron: '^33.0.0', react: '^18.0.0' },
      scripts: { test: 'vitest run', lint: 'eslint .', typecheck: 'tsc --noEmit', build: 'vite build' }
    }), 'utf8')
    await writeFile(join(root, 'package-lock.json'), '{}\n', 'utf8')

    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' })
    execFileSync('git', ['config', 'user.email', 'observer@example.test'], { cwd: root })
    execFileSync('git', ['config', 'user.name', 'Observer Test'], { cwd: root })
    execFileSync('git', ['add', '.'], { cwd: root })
    execFileSync('git', ['reset', 'src/untracked.ts'], { cwd: root, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'Initial fixture'], { cwd: root, stdio: 'ignore' })

    const snapshot = await observeRepository(root, { repositoryId: 'repo-fixture', now: 42 })
    expect(snapshot.capturedAt).toBe(42)
    expect(snapshot.files).toContain('src/untracked.ts')
    expect(snapshot.files.some((file) => file.includes('node_modules'))).toBe(false)
    expect(snapshot.languages.find((item) => item.name === 'TypeScript')?.files).toBe(2)
    expect(snapshot.frameworks).toEqual(expect.arrayContaining(['Electron', 'React']))
    expect(snapshot.packageManagers).toContain('npm')
    expect(snapshot.detectedCommands.map((item) => item.kind)).toEqual(
      expect.arrayContaining(['test', 'lint', 'typecheck', 'build'])
    )
    expect(snapshot.todoItems[0]).toMatchObject({ file: 'src/components/Button.tsx', line: 1 })
    expect(snapshot.components).toContain('src/components/Button.tsx')
    expect(snapshot.recentCommits[0]).toContain('Initial fixture')
  })
})

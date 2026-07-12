import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { validatePatch } from '../../src/main/safety/patch'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('validated patch workflow', () => {
  it('resolves safe files inside a temporary project and rejects traversal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'akorith-patch-test-'))
    roots.push(root)

    const accepted = validatePatch(root, [{ operation: 'create', path: 'src/feature.ts', content: 'export const ready = true\n' }])
    expect(accepted.ok).toBe(true)
    const target = accepted.files[0]?.absolute
    expect(target).toBeTruthy()

    await mkdir(dirname(target!), { recursive: true })
    await writeFile(target!, 'export const ready = true\n', 'utf8')
    expect(await readFile(target!, 'utf8')).toContain('ready = true')

    const rejected = validatePatch(root, [{ operation: 'create', path: '../outside.ts', content: 'nope' }])
    expect(rejected.ok).toBe(false)
    expect(rejected.files[0]?.reason).toMatch(/escapes/i)
  })
})

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { throwIfBenchmarkAborted } from './cancellation'
import type { BenchmarkWorkspaceFactory } from './types'

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

export interface TemporaryBenchmarkWorkspaceOptions {
  /** Must be an Akorith-owned directory; defaults to the operating-system temp root. */
  baseDirectory?: string
}

/** Materialize embedded fixture files into a fresh, disposable workspace. */
export function createTemporaryBenchmarkWorkspaceFactory(
  options: TemporaryBenchmarkWorkspaceOptions = {}
): BenchmarkWorkspaceFactory {
  const configuredBase = resolve(options.baseDirectory ?? join(tmpdir(), 'akorith-benchmark-lab'))
  return {
    async prepare(fixture, seed, signal) {
      throwIfBenchmarkAborted(signal)
      await mkdir(configuredBase, { recursive: true })
      const canonicalBase = await realpath(configuredBase)
      const workspaceRoot = await mkdtemp(join(canonicalBase, 'run-'))
      const canonicalRoot = await realpath(workspaceRoot)
      if (!isWithin(canonicalBase, canonicalRoot)) {
        throw new Error('Temporary benchmark workspace escaped its managed base directory.')
      }
      let disposed = false
      try {
        for (const file of fixture.workspaceFiles) {
          throwIfBenchmarkAborted(signal)
          const destination = resolve(canonicalRoot, file.path)
          if (!isWithin(canonicalRoot, destination)) throw new Error(`Fixture path escaped its workspace: ${file.path}`)
          await mkdir(dirname(destination), { recursive: true })
          await writeFile(destination, file.content, { encoding: 'utf8', flag: 'wx' })
        }
      } catch (error) {
        await rm(canonicalRoot, { recursive: true, force: true, maxRetries: 3 })
        throw error
      }
      return {
        id: `${fixture.id}:${seed}:${canonicalRoot}`,
        rootPath: canonicalRoot,
        isolation: 'temporary_directory',
        sourceReadOnly: true,
        async dispose() {
          if (disposed) return
          disposed = true
          if (!isWithin(canonicalBase, canonicalRoot)) throw new Error('Refusing to remove a benchmark path outside its managed base.')
          await rm(canonicalRoot, { recursive: true, force: true, maxRetries: 3 })
        }
      }
    }
  }
}

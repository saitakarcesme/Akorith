import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, rmdir, stat, unlink } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { RepositoryError } from './errors'
import { canonicalExistingPath } from './paths'
import type { RepositoryLease, RepositoryLeaseInfo } from './types'

interface StoredLease extends RepositoryLeaseInfo {
  schemaVersion: 1
  pid: number
}

export interface AcquireLeaseOptions {
  owner: string
  ttlMs?: number
}

export interface RepositoryLeaseManagerOptions {
  defaultTtlMs?: number
  now?: () => number
}

function validateTtl(ttlMs: number): number {
  if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 60 * 60 * 1_000) {
    throw new RepositoryError('lock-conflict', 'Repository lease duration is outside the supported range.', {
      operation: 'acquire repository lease',
      recoverable: true
    })
  }
  return ttlMs
}

function parseLease(value: string): StoredLease | null {
  try {
    const record = JSON.parse(value) as Partial<StoredLease>
    if (
      record.schemaVersion !== 1 ||
      typeof record.token !== 'string' ||
      typeof record.owner !== 'string' ||
      typeof record.canonicalPath !== 'string' ||
      typeof record.acquiredAt !== 'number' ||
      typeof record.expiresAt !== 'number' ||
      typeof record.pid !== 'number'
    ) return null
    return record as StoredLease
  } catch {
    return null
  }
}

function leaseKey(canonicalPath: string): string {
  const stable = process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath
  return createHash('sha256').update(stable).digest('hex')
}

class FileRepositoryLease implements RepositoryLease {
  private readonly manager: RepositoryLeaseManager
  private released = false
  info: RepositoryLeaseInfo

  constructor(manager: RepositoryLeaseManager, info: RepositoryLeaseInfo) {
    this.manager = manager
    this.info = { ...info }
  }

  async refresh(ttlMs?: number): Promise<RepositoryLeaseInfo> {
    if (this.released) throw new RepositoryError('lock-lost', 'Repository lease was already released.', { operation: 'refresh lease' })
    this.info = await this.manager.refreshLease(this.info, ttlMs)
    return { ...this.info }
  }

  async release(): Promise<void> {
    if (this.released) return
    await this.manager.releaseLease(this.info)
    this.released = true
  }
}

/**
 * Cross-process directory leases keyed by canonical repository path. Each
 * owner gets a token-named record, so stale replacement can never make an old
 * release unlink a newer owner's lease.
 */
export class RepositoryLeaseManager {
  private readonly lockRoot: string
  private readonly defaultTtlMs: number
  private readonly now: () => number

  constructor(lockRoot: string, options: RepositoryLeaseManagerOptions = {}) {
    if (!isAbsolute(lockRoot)) throw new Error('Repository lock root must be absolute.')
    this.lockRoot = resolve(lockRoot)
    this.defaultTtlMs = validateTtl(options.defaultTtlMs ?? 120_000)
    this.now = options.now ?? Date.now
  }

  private async prepareRoot(): Promise<string> {
    await mkdir(this.lockRoot, { recursive: true })
    return canonicalExistingPath(this.lockRoot)
  }

  private async leaseDirectory(canonicalPath: string): Promise<string> {
    return join(await this.prepareRoot(), `${leaseKey(canonicalPath)}.lease`)
  }

  private tokenFile(directory: string, token: string): string {
    return join(directory, `${token}.json`)
  }

  private async readCurrent(directory: string): Promise<{ record: StoredLease | null; modifiedAt: number }> {
    const info = await stat(directory)
    const entries = (await readdir(directory)).filter((entry) => /^[0-9a-f-]{36}\.json$/i.test(entry))
    if (entries.length !== 1) return { record: null, modifiedAt: info.mtimeMs }
    try {
      return { record: parseLease(await readFile(join(directory, entries[0]), 'utf8')), modifiedAt: info.mtimeMs }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { record: null, modifiedAt: info.mtimeMs }
      throw error
    }
  }

  async acquire(repositoryPath: string, options: AcquireLeaseOptions): Promise<RepositoryLease> {
    const owner = options.owner.trim().slice(0, 120)
    if (!owner || /[\0\r\n]/.test(owner)) {
      throw new RepositoryError('lock-conflict', 'Repository lease owner is invalid.', {
        operation: 'acquire repository lease',
        recoverable: true
      })
    }
    const ttlMs = validateTtl(options.ttlMs ?? this.defaultTtlMs)
    const canonicalPath = await canonicalExistingPath(repositoryPath)
    const directory = await this.leaseDirectory(canonicalPath)

    for (let attempt = 0; attempt < 5; attempt++) {
      const acquiredAt = this.now()
      const record: StoredLease = {
        schemaVersion: 1,
        token: randomUUID(),
        owner,
        canonicalPath,
        acquiredAt,
        expiresAt: acquiredAt + ttlMs,
        pid: process.pid
      }
      try {
        await mkdir(directory, { recursive: false, mode: 0o700 })
        try {
          const handle = await open(this.tokenFile(directory, record.token), 'wx', 0o600)
          try {
            await handle.writeFile(JSON.stringify(record), 'utf8')
            await handle.sync()
          } finally {
            await handle.close()
          }
        } catch (error) {
          await rm(directory, { recursive: true, force: true }).catch(() => undefined)
          throw error
        }
        return new FileRepositoryLease(this, record)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        let current: { record: StoredLease | null; modifiedAt: number }
        try {
          current = await this.readCurrent(directory)
        } catch (readError) {
          if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw readError
        }
        const stale = current.record
          ? current.record.expiresAt <= this.now()
          : current.modifiedAt + this.defaultTtlMs <= this.now()
        if (!stale) {
          throw new RepositoryError('lock-conflict', `Repository is already leased by ${current.record?.owner ?? 'another process'}.`, {
            operation: 'acquire repository lease',
            recoverable: true
          })
        }
        const staleDirectory = `${directory}.stale-${randomUUID()}`
        try {
          await rename(directory, staleDirectory)
          await rm(staleDirectory, { recursive: true, force: true })
        } catch (renameError) {
          if ((renameError as NodeJS.ErrnoException).code === 'ENOENT') continue
          throw renameError
        }
      }
    }
    throw new RepositoryError('lock-conflict', 'Repository lease could not be acquired after concurrent retries.', {
      operation: 'acquire repository lease',
      recoverable: true
    })
  }

  async inspect(repositoryPath: string): Promise<RepositoryLeaseInfo | null> {
    const canonicalPath = await canonicalExistingPath(repositoryPath)
    const directory = await this.leaseDirectory(canonicalPath)
    try {
      const { record } = await this.readCurrent(directory)
      return record ? { ...record } : null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async refreshLease(info: RepositoryLeaseInfo, ttlMs = this.defaultTtlMs): Promise<RepositoryLeaseInfo> {
    const duration = validateTtl(ttlMs)
    const directory = await this.leaseDirectory(info.canonicalPath)
    const file = this.tokenFile(directory, info.token)
    let record: StoredLease | null
    try {
      record = parseLease(await readFile(file, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') record = null
      else throw error
    }
    if (!record || record.token !== info.token || record.expiresAt <= this.now()) {
      throw new RepositoryError('lock-lost', 'Repository lease expired or was replaced.', {
        operation: 'refresh repository lease',
        recoverable: true
      })
    }
    const refreshed: StoredLease = { ...record, expiresAt: this.now() + duration }
    const handle = await open(file, 'r+', 0o600)
    try {
      await handle.truncate(0)
      await handle.writeFile(JSON.stringify(refreshed), 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    const confirmed = parseLease(await readFile(file, 'utf8').catch(() => ''))
    if (!confirmed || confirmed.token !== info.token) {
      throw new RepositoryError('lock-lost', 'Repository lease was replaced while refreshing.', {
        operation: 'refresh repository lease',
        recoverable: true
      })
    }
    return { ...refreshed }
  }

  async releaseLease(info: RepositoryLeaseInfo): Promise<void> {
    const directory = await this.leaseDirectory(info.canonicalPath)
    const file = this.tokenFile(directory, info.token)
    try {
      await unlink(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new RepositoryError('lock-lost', 'Repository lease is no longer owned by this operation.', {
          operation: 'release repository lease',
          recoverable: true
        })
      }
      throw error
    }
    try {
      await rmdir(directory)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error
      if (code === 'ENOTEMPTY' || code === 'EEXIST') {
        throw new RepositoryError('lock-lost', 'Repository lease directory contains another owner.', {
          operation: 'release repository lease',
          recoverable: true
        })
      }
    }
  }
}

import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { RemoteNodeTokenVault } from './client-manager-types'

const TOKEN_FILE_SCHEMA_VERSION = 1
const MAX_TOKEN_FILE_BYTES = 1024 * 1024
const PROFILE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/

export interface ElectronSafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encryptedValue: Buffer): string
}

interface PersistedEncryptedTokens {
  schemaVersion: typeof TOKEN_FILE_SCHEMA_VERSION
  encryptedTokens: Record<string, string>
}

async function atomicWrite(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`
  const handle = await open(temporary, 'w', 0o600)
  try {
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, filePath)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

function validateProfileId(profileId: string): void {
  if (!PROFILE_ID_PATTERN.test(profileId)) throw new Error('Remote node profile id is invalid.')
}

/**
 * File-backed token vault encrypted by Electron safeStorage. The file contains only
 * platform-encrypted ciphertext, never a bearer token or pairing code.
 */
export class ElectronSafeStorageTokenVault implements RemoteNodeTokenVault {
  private readonly filePath: string
  private queue: Promise<void> = Promise.resolve()

  constructor(dataDir: string, private readonly safeStorage: ElectronSafeStorageLike, fileName = 'remote-node-secrets.json') {
    this.filePath = path.join(path.resolve(dataDir), fileName)
  }

  get(profileId: string): Promise<string | undefined> {
    validateProfileId(profileId)
    return this.exclusive(async () => {
      const state = await this.readState()
      const encoded = state.encryptedTokens[profileId]
      if (!encoded) return undefined
      this.ensureEncryption()
      try {
        return this.safeStorage.decryptString(Buffer.from(encoded, 'base64'))
      } catch {
        throw new Error('Remote node credential could not be decrypted on this device.')
      }
    })
  }

  set(profileId: string, token: string): Promise<void> {
    validateProfileId(profileId)
    if (!/^akrn_v1\.[A-Za-z0-9._:-]+\.[A-Za-z0-9_-]{20,}$/.test(token)) {
      return Promise.reject(new Error('Remote node credential is invalid.'))
    }
    return this.exclusive(async () => {
      this.ensureEncryption()
      const state = await this.readState()
      const encrypted = this.safeStorage.encryptString(token)
      state.encryptedTokens[profileId] = Buffer.from(encrypted).toString('base64')
      await atomicWrite(this.filePath, `${JSON.stringify(state, null, 2)}\n`)
    })
  }

  delete(profileId: string): Promise<void> {
    validateProfileId(profileId)
    return this.exclusive(async () => {
      const state = await this.readState()
      if (!(profileId in state.encryptedTokens)) return
      delete state.encryptedTokens[profileId]
      await atomicWrite(this.filePath, `${JSON.stringify(state, null, 2)}\n`)
    })
  }

  private ensureEncryption(): void {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure credential storage is unavailable. Remote node credentials were not saved.')
    }
  }

  private async readState(): Promise<PersistedEncryptedTokens> {
    let contents: string
    try {
      const file = await readFile(this.filePath)
      if (file.byteLength > MAX_TOKEN_FILE_BYTES) throw new Error('Remote node credential store exceeds its size cap.')
      contents = file.toString('utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { schemaVersion: TOKEN_FILE_SCHEMA_VERSION, encryptedTokens: {} }
      }
      throw error
    }
    let value: unknown
    try { value = JSON.parse(contents) }
    catch { throw new Error('Remote node credential store is not valid JSON.') }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Remote node credential store has an invalid shape.')
    }
    const input = value as Record<string, unknown>
    if (input.schemaVersion !== TOKEN_FILE_SCHEMA_VERSION || !input.encryptedTokens || typeof input.encryptedTokens !== 'object') {
      throw new Error('Remote node credential store uses an unsupported schema.')
    }
    const encryptedTokens: Record<string, string> = {}
    for (const [id, encoded] of Object.entries(input.encryptedTokens as Record<string, unknown>)) {
      if (PROFILE_ID_PATTERN.test(id) && typeof encoded === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
        encryptedTokens[id] = encoded
      }
    }
    return { schemaVersion: TOKEN_FILE_SCHEMA_VERSION, encryptedTokens }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }
}

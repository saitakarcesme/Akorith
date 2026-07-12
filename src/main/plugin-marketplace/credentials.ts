import type {
  CredentialInput,
  CredentialMetadata,
  CredentialUseContext,
  CredentialVault
} from './types'

const CREDENTIAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function cloneMetadata(metadata: CredentialMetadata): CredentialMetadata {
  return { ...metadata }
}

function validateInput(input: CredentialInput): void {
  if (!CREDENTIAL_ID_PATTERN.test(input.id)) throw new Error('Credential id is invalid.')
  if (!input.pluginId.trim()) throw new Error('Credential plugin id is required.')
  if (!input.label.trim()) throw new Error('Credential label is required.')
  const length = typeof input.secret === 'string' ? Buffer.byteLength(input.secret, 'utf8') : input.secret.byteLength
  if (length === 0) throw new Error('Credential secret cannot be empty.')
}

function validateUse(metadata: CredentialMetadata, context: CredentialUseContext): void {
  if (metadata.pluginId !== context.pluginId) throw new Error('Credential is not owned by the requesting plugin.')
  if (!context.purpose.trim()) throw new Error('Credential use requires an auditable purpose.')
}

function secretBytes(secret: string | Uint8Array): Uint8Array {
  return typeof secret === 'string' ? Uint8Array.from(Buffer.from(secret, 'utf8')) : Uint8Array.from(secret)
}

/**
 * Test-only vault. It intentionally has no getter: plaintext is exposed only to a
 * scoped callback, and callback copies are zeroed immediately afterwards.
 */
export class InMemoryCredentialVault implements CredentialVault {
  private readonly records = new Map<string, { metadata: CredentialMetadata; secret: Uint8Array }>()
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  async put(input: CredentialInput): Promise<CredentialMetadata> {
    validateInput(input)
    const timestamp = this.now()
    const previous = this.records.get(input.id)
    previous?.secret.fill(0)
    const metadata: CredentialMetadata = {
      id: input.id,
      pluginId: input.pluginId,
      label: input.label,
      createdAt: previous?.metadata.createdAt ?? timestamp,
      updatedAt: timestamp
    }
    this.records.set(input.id, { metadata, secret: secretBytes(input.secret) })
    return cloneMetadata(metadata)
  }

  async has(id: string): Promise<boolean> {
    return this.records.has(id)
  }

  async list(pluginId?: string): Promise<CredentialMetadata[]> {
    return [...this.records.values()]
      .map((record) => record.metadata)
      .filter((metadata) => !pluginId || metadata.pluginId === pluginId)
      .map(cloneMetadata)
  }

  async delete(id: string): Promise<boolean> {
    const record = this.records.get(id)
    if (!record) return false
    record.secret.fill(0)
    return this.records.delete(id)
  }

  async use(
    id: string,
    context: CredentialUseContext,
    consumer: (secret: Uint8Array) => void | Promise<void>
  ): Promise<void> {
    const record = this.records.get(id)
    if (!record) throw new Error('Credential was not found.')
    validateUse(record.metadata, context)
    const cleartext = Uint8Array.from(record.secret)
    try {
      await consumer(cleartext)
    } finally {
      cleartext.fill(0)
    }
  }

  clear(): void {
    for (const record of this.records.values()) record.secret.fill(0)
    this.records.clear()
  }
}

/** Structural subset of Electron's safeStorage export; inject it from trusted main-process code. */
export interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean
  encryptString(plaintext: string): Buffer
  decryptString(encrypted: Buffer): string
}

export interface EncryptedCredentialRecord {
  metadata: CredentialMetadata
  ciphertext: Uint8Array
}

/** Persistent implementations store only OS-encrypted bytes plus non-secret metadata. */
export interface EncryptedCredentialStore {
  writeEncrypted(record: EncryptedCredentialRecord): Promise<void>
  readEncrypted(id: string): Promise<EncryptedCredentialRecord | null>
  listMetadata(pluginId?: string): Promise<CredentialMetadata[]>
  deleteEncrypted(id: string): Promise<boolean>
}

function cloneEncryptedRecord(record: EncryptedCredentialRecord): EncryptedCredentialRecord {
  return { metadata: cloneMetadata(record.metadata), ciphertext: Uint8Array.from(record.ciphertext) }
}

/** Test adapter for exercising the safeStorage seam without Electron or filesystem writes. */
export class InMemoryEncryptedCredentialStore implements EncryptedCredentialStore {
  private readonly records = new Map<string, EncryptedCredentialRecord>()

  async writeEncrypted(record: EncryptedCredentialRecord): Promise<void> {
    this.records.set(record.metadata.id, cloneEncryptedRecord(record))
  }

  async readEncrypted(id: string): Promise<EncryptedCredentialRecord | null> {
    const record = this.records.get(id)
    return record ? cloneEncryptedRecord(record) : null
  }

  async listMetadata(pluginId?: string): Promise<CredentialMetadata[]> {
    return [...this.records.values()]
      .map((record) => record.metadata)
      .filter((metadata) => !pluginId || metadata.pluginId === pluginId)
      .map(cloneMetadata)
  }

  async deleteEncrypted(id: string): Promise<boolean> {
    return this.records.delete(id)
  }
}

/**
 * Production vault seam. It fails closed when Electron safeStorage is unavailable;
 * callers must never substitute a plaintext store.
 */
export class SafeStorageCredentialVault implements CredentialVault {
  private readonly safeStorage: SafeStorageAdapter
  private readonly store: EncryptedCredentialStore
  private readonly now: () => number

  constructor(safeStorage: SafeStorageAdapter, store: EncryptedCredentialStore, now: () => number = Date.now) {
    this.safeStorage = safeStorage
    this.store = store
    this.now = now
  }

  private assertEncryptionAvailable(): void {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('Operating-system credential encryption is unavailable; credential storage is disabled.')
    }
  }

  async put(input: CredentialInput): Promise<CredentialMetadata> {
    validateInput(input)
    this.assertEncryptionAvailable()
    const timestamp = this.now()
    const previous = await this.store.readEncrypted(input.id)
    const metadata: CredentialMetadata = {
      id: input.id,
      pluginId: input.pluginId,
      label: input.label,
      createdAt: previous?.metadata.createdAt ?? timestamp,
      updatedAt: timestamp
    }
    const cleartext = secretBytes(input.secret)
    try {
      const encoded = Buffer.from(cleartext).toString('base64')
      const ciphertext = this.safeStorage.encryptString(encoded)
      if (ciphertext.byteLength === 0) throw new Error('Credential encryption returned an empty payload.')
      await this.store.writeEncrypted({ metadata, ciphertext: Uint8Array.from(ciphertext) })
      return cloneMetadata(metadata)
    } finally {
      cleartext.fill(0)
    }
  }

  async has(id: string): Promise<boolean> {
    return (await this.store.readEncrypted(id)) !== null
  }

  async list(pluginId?: string): Promise<CredentialMetadata[]> {
    return this.store.listMetadata(pluginId)
  }

  async delete(id: string): Promise<boolean> {
    return this.store.deleteEncrypted(id)
  }

  async use(
    id: string,
    context: CredentialUseContext,
    consumer: (secret: Uint8Array) => void | Promise<void>
  ): Promise<void> {
    this.assertEncryptionAvailable()
    const record = await this.store.readEncrypted(id)
    if (!record) throw new Error('Credential was not found.')
    validateUse(record.metadata, context)
    const encoded = this.safeStorage.decryptString(Buffer.from(record.ciphertext))
    const cleartext = Uint8Array.from(Buffer.from(encoded, 'base64'))
    if (cleartext.byteLength === 0) throw new Error('Credential decryption returned an empty payload.')
    try {
      await consumer(cleartext)
    } finally {
      cleartext.fill(0)
    }
  }
}

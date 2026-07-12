import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'

export type PairingErrorCode =
  | 'pairing_not_found'
  | 'pairing_expired'
  | 'pairing_replayed'
  | 'pairing_locked'
  | 'invalid_pairing_code'
  | 'invalid_device_name'

export class PairingError extends Error {
  constructor(readonly code: PairingErrorCode, message: string) {
    super(message)
    this.name = 'PairingError'
  }
}

export interface PairingChallengeView {
  pairingId: string
  code: string
  createdAt: number
  expiresAt: number
  nodeName: string
}

export interface ApprovedDeviceView {
  id: string
  name: string
  createdAt: number
  lastAuthenticatedAt?: number
  revokedAt?: number
}

export interface PairingApproval {
  device: ApprovedDeviceView
  deviceToken: string
}

interface PairingChallengeRecord {
  id: string
  nodeName: string
  createdAt: number
  expiresAt: number
  salt: Buffer
  digest: Buffer
  attempts: number
  state: 'pending' | 'used' | 'expired' | 'locked'
}

interface DeviceRecord extends ApprovedDeviceView {
  tokenDigest: Buffer
}

export interface PairingAuthorityOptions {
  defaultTtlMs?: number
  maxTtlMs?: number
  maxAttempts?: number
  maxActiveChallenges?: number
  persistedState?: unknown
}

export interface PersistedPairingAuthorityState {
  schemaVersion: 1
  devices: Array<{
    id: string
    name: string
    createdAt: number
    lastAuthenticatedAt?: number
    revokedAt?: number
    tokenDigestBase64: string
  }>
}

const DUMMY_TOKEN_DIGEST = createHash('sha256').update('akorith-remote-node-invalid-token').digest()

function digestPairingCode(salt: Buffer, code: string): Buffer {
  return createHash('sha256').update(salt).update(':').update(code).digest()
}

function digestDeviceToken(token: string): Buffer {
  return createHash('sha256').update(token).digest()
}

function equalDigest(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right)
}

function cleanName(value: string, fallback: string): string {
  const clean = value.trim().replace(/[\0\r\n]/g, '').slice(0, 100)
  return clean || fallback
}

export class PairingAuthority {
  private readonly challenges = new Map<string, PairingChallengeRecord>()
  private readonly devices = new Map<string, DeviceRecord>()
  private readonly defaultTtlMs: number
  private readonly maxTtlMs: number
  private readonly maxAttempts: number
  private readonly maxActiveChallenges: number

  constructor(options: PairingAuthorityOptions = {}) {
    this.defaultTtlMs = Math.min(Math.max(options.defaultTtlMs ?? 2 * 60_000, 10_000), 10 * 60_000)
    this.maxTtlMs = Math.min(Math.max(options.maxTtlMs ?? 10 * 60_000, this.defaultTtlMs), 30 * 60_000)
    this.maxAttempts = Math.min(Math.max(options.maxAttempts ?? 5, 1), 20)
    this.maxActiveChallenges = Math.min(Math.max(options.maxActiveChallenges ?? 8, 1), 64)
    this.restore(options.persistedState)
  }

  beginPairing(input: { nodeName: string; now?: number; ttlMs?: number }): PairingChallengeView {
    const now = input.now ?? Date.now()
    this.expireChallenges(now)
    const active = [...this.challenges.values()].filter((challenge) => challenge.state === 'pending').length
    if (active >= this.maxActiveChallenges) throw new PairingError('pairing_locked', 'Too many active pairing requests.')
    const ttlMs = Math.min(Math.max(Math.trunc(input.ttlMs ?? this.defaultTtlMs), 10_000), this.maxTtlMs)
    const pairingId = randomUUID()
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    const salt = randomBytes(24)
    this.challenges.set(pairingId, {
      id: pairingId,
      nodeName: cleanName(input.nodeName, 'Akorith Node'),
      createdAt: now,
      expiresAt: now + ttlMs,
      salt,
      digest: digestPairingCode(salt, code),
      attempts: 0,
      state: 'pending'
    })
    return { pairingId, code, createdAt: now, expiresAt: now + ttlMs, nodeName: cleanName(input.nodeName, 'Akorith Node') }
  }

  approvePairing(input: { pairingId: string; code: string; deviceName: string; now?: number }): PairingApproval {
    const now = input.now ?? Date.now()
    const challenge = this.challenges.get(input.pairingId)
    if (!challenge) throw new PairingError('pairing_not_found', 'Pairing request was not found.')
    if (challenge.state === 'used') throw new PairingError('pairing_replayed', 'Pairing code has already been used.')
    if (challenge.state === 'locked') throw new PairingError('pairing_locked', 'Pairing request is locked.')
    if (challenge.state === 'expired' || now >= challenge.expiresAt) {
      challenge.state = 'expired'
      throw new PairingError('pairing_expired', 'Pairing code has expired.')
    }
    const deviceName = cleanName(input.deviceName, '')
    if (!deviceName) throw new PairingError('invalid_device_name', 'Device name is required.')

    const candidate = digestPairingCode(challenge.salt, typeof input.code === 'string' ? input.code : '')
    if (!equalDigest(candidate, challenge.digest)) {
      challenge.attempts += 1
      if (challenge.attempts >= this.maxAttempts) {
        challenge.state = 'locked'
        throw new PairingError('pairing_locked', 'Pairing request is locked after repeated failures.')
      }
      throw new PairingError('invalid_pairing_code', 'Pairing code is invalid.')
    }

    challenge.state = 'used'
    const deviceId = randomUUID()
    const secret = randomBytes(32).toString('base64url')
    const deviceToken = `akrn_v1.${deviceId}.${secret}`
    const record: DeviceRecord = {
      id: deviceId,
      name: deviceName,
      createdAt: now,
      tokenDigest: digestDeviceToken(deviceToken)
    }
    this.devices.set(deviceId, record)
    return { device: this.toView(record), deviceToken }
  }

  authenticate(deviceToken: string, now = Date.now()): ApprovedDeviceView | null {
    const parts = typeof deviceToken === 'string' ? deviceToken.split('.') : []
    const deviceId = parts.length === 3 && parts[0] === 'akrn_v1' ? parts[1] : ''
    const record = this.devices.get(deviceId)
    const expected = record?.tokenDigest ?? DUMMY_TOKEN_DIGEST
    const candidate = digestDeviceToken(typeof deviceToken === 'string' ? deviceToken : '')
    const valid = equalDigest(candidate, expected)
    if (!valid || !record || record.revokedAt !== undefined) return null
    record.lastAuthenticatedAt = now
    return this.toView(record)
  }

  revokeDevice(deviceId: string, now = Date.now()): boolean {
    const record = this.devices.get(deviceId)
    if (!record || record.revokedAt !== undefined) return false
    record.revokedAt = now
    return true
  }

  listDevices(): ApprovedDeviceView[] {
    return [...this.devices.values()].map((record) => this.toView(record))
  }

  exportState(): PersistedPairingAuthorityState {
    return {
      schemaVersion: 1,
      devices: [...this.devices.values()].map((record) => ({
        id: record.id,
        name: record.name,
        createdAt: record.createdAt,
        ...(record.lastAuthenticatedAt !== undefined ? { lastAuthenticatedAt: record.lastAuthenticatedAt } : {}),
        ...(record.revokedAt !== undefined ? { revokedAt: record.revokedAt } : {}),
        tokenDigestBase64: record.tokenDigest.toString('base64')
      }))
    }
  }

  private restore(value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    const raw = value as Record<string, unknown>
    if (raw.schemaVersion !== 1 || !Array.isArray(raw.devices)) return
    for (const candidate of raw.devices.slice(0, 1_000)) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
      const device = candidate as Record<string, unknown>
      const id = typeof device.id === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(device.id) ? device.id : null
      const name = typeof device.name === 'string' ? cleanName(device.name, '') : ''
      const createdAt = typeof device.createdAt === 'number' && Number.isSafeInteger(device.createdAt) && device.createdAt >= 0
        ? device.createdAt
        : null
      let digest: Buffer
      try { digest = Buffer.from(typeof device.tokenDigestBase64 === 'string' ? device.tokenDigestBase64 : '', 'base64') }
      catch { continue }
      if (!id || !name || createdAt === null || digest.length !== 32 || this.devices.has(id)) continue
      const optionalTimestamp = (entry: unknown): number | undefined =>
        typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= createdAt ? entry : undefined
      const record: DeviceRecord = {
        id,
        name,
        createdAt,
        tokenDigest: digest,
        ...(optionalTimestamp(device.lastAuthenticatedAt) !== undefined
          ? { lastAuthenticatedAt: optionalTimestamp(device.lastAuthenticatedAt) }
          : {}),
        ...(optionalTimestamp(device.revokedAt) !== undefined ? { revokedAt: optionalTimestamp(device.revokedAt) } : {})
      }
      this.devices.set(id, record)
    }
  }

  private expireChallenges(now: number): void {
    for (const challenge of this.challenges.values()) {
      if (challenge.state === 'pending' && now >= challenge.expiresAt) challenge.state = 'expired'
    }
  }

  private toView(record: DeviceRecord): ApprovedDeviceView {
    return {
      id: record.id,
      name: record.name,
      createdAt: record.createdAt,
      ...(record.lastAuthenticatedAt !== undefined ? { lastAuthenticatedAt: record.lastAuthenticatedAt } : {}),
      ...(record.revokedAt !== undefined ? { revokedAt: record.revokedAt } : {})
    }
  }
}

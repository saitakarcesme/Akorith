import { app } from 'electron'
import { randomUUID } from 'crypto'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { basename, extname, join, resolve, sep } from 'path'

export type ChatAttachmentKind = 'image' | 'document' | 'code' | 'file'

export interface IncomingChatAttachment {
  id: string
  name: string
  mimeType: string
  size: number
  kind: ChatAttachmentKind
  dataBase64: string
}

export interface StoredChatAttachment {
  id: string
  name: string
  mimeType: string
  size: number
  kind: ChatAttachmentKind
  path: string
  dataBase64?: string
}

export interface PublicChatAttachment {
  id: string
  name: string
  mimeType: string
  size: number
  kind: ChatAttachmentKind
  dataBase64?: string
}

const MAX_ATTACHMENTS = 8
const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024
const MAX_TOTAL_BYTES = 40 * 1024 * 1024
const VALID_ID = /^[\w-]{1,80}$/
const VALID_KIND = new Set<ChatAttachmentKind>(['image', 'document', 'code', 'file'])
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

function rootDir(): string {
  return join(app.getPath('userData'), 'chat-attachments')
}

function safeName(value: string): string {
  const leaf = basename(value).replace(/[\0\r\n]/g, '').replace(/[^\p{L}\p{N}._ -]+/gu, '_').trim()
  return (leaf || `attachment${extname(value)}`).slice(0, 180)
}

function managedPath(path: string): boolean {
  const root = resolve(rootDir())
  const target = resolve(path)
  return target === root || target.startsWith(`${root}${sep}`)
}

export function validChatAttachments(value: unknown): value is IncomingChatAttachment[] {
  if (value === undefined) return true
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) return false
  let total = 0
  for (const item of value) {
    if (!item || typeof item !== 'object') return false
    const row = item as Partial<IncomingChatAttachment>
    if (
      typeof row.id !== 'string' || !VALID_ID.test(row.id) ||
      typeof row.name !== 'string' || !row.name.trim() || row.name.length > 200 ||
      typeof row.mimeType !== 'string' || !row.mimeType.trim() || row.mimeType.length > 160 ||
      typeof row.size !== 'number' || !Number.isInteger(row.size) || row.size < 1 || row.size > MAX_ATTACHMENT_BYTES ||
      typeof row.kind !== 'string' || !VALID_KIND.has(row.kind as ChatAttachmentKind) ||
      typeof row.dataBase64 !== 'string' || !row.dataBase64 || !BASE64.test(row.dataBase64)
    ) return false
    const decodedSize = Buffer.byteLength(row.dataBase64, 'base64')
    if (decodedSize < 1 || decodedSize > MAX_ATTACHMENT_BYTES || Math.abs(decodedSize - row.size) > 2) return false
    total += decodedSize
    if (total > MAX_TOTAL_BYTES) return false
  }
  return true
}

export async function storeChatAttachments(
  sessionId: string,
  requestId: string,
  attachments: IncomingChatAttachment[]
): Promise<StoredChatAttachment[]> {
  if (!attachments.length) return []
  const directory = join(rootDir(), safeName(sessionId), safeName(requestId))
  await mkdir(directory, { recursive: true })
  const stored: StoredChatAttachment[] = []
  try {
    for (const attachment of attachments) {
      const id = VALID_ID.test(attachment.id) ? attachment.id : randomUUID()
      const path = join(directory, `${id}-${safeName(attachment.name)}`)
      const bytes = Buffer.from(attachment.dataBase64, 'base64')
      await writeFile(path, bytes, { flag: 'wx' })
      stored.push({
        id,
        name: safeName(attachment.name),
        mimeType: attachment.mimeType,
        size: bytes.byteLength,
        kind: attachment.kind,
        path,
        dataBase64: attachment.kind === 'image' ? attachment.dataBase64 : undefined
      })
    }
    return stored
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

export async function publicChatAttachments(
  attachments: Omit<StoredChatAttachment, 'dataBase64'>[]
): Promise<PublicChatAttachment[]> {
  return Promise.all(attachments.map(async (attachment): Promise<PublicChatAttachment> => {
    const base: PublicChatAttachment = {
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
      kind: attachment.kind
    }
    if (attachment.kind !== 'image' || attachment.size > MAX_ATTACHMENT_BYTES || !managedPath(attachment.path)) return base
    try {
      base.dataBase64 = (await readFile(attachment.path)).toString('base64')
    } catch {
      // Keep the metadata visible even if the backing file was removed outside Akorith.
    }
    return base
  }))
}

export async function removeSessionAttachments(sessionId: string): Promise<void> {
  if (!VALID_ID.test(sessionId)) return
  await rm(join(rootDir(), sessionId), { recursive: true, force: true }).catch(() => {})
}

export function attachmentPrompt(attachments: StoredChatAttachment[]): string {
  if (!attachments.length) return ''
  const rows = attachments.map((item) => `- ${item.name} (${item.mimeType}, ${item.size} bytes): ${item.path}`)
  return `\n\nAttached files (local paths managed by Akorith):\n${rows.join('\n')}\nUse these files as context. Do not modify the originals.`
}

export async function inlineTextAttachmentContext(attachments: StoredChatAttachment[]): Promise<string> {
  const textFiles = attachments.filter((item) => item.kind === 'code' || (item.kind === 'document' && /(?:text|json|xml|yaml|csv|markdown)/i.test(item.mimeType)))
  if (!textFiles.length) return ''
  let remaining = 120_000
  const blocks: string[] = []
  for (const item of textFiles) {
    if (remaining <= 0 || !managedPath(item.path)) break
    try {
      const content = (await readFile(item.path, 'utf8')).slice(0, remaining)
      remaining -= content.length
      blocks.push(`\n--- ${item.name} ---\n${content}`)
    } catch {
      // Binary or externally removed files stay available by path only.
    }
  }
  return blocks.length ? `\n\nInline attachment context:${blocks.join('')}` : ''
}

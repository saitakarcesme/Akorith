import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { checkWritePath } from '../safety'
import type { AgentActionFile } from './types'

// Phase 52: deterministic file operations for agents. Every path is validated
// against the allowed root before any write. Deletes are never performed by
// agents (only proposed). No absolute paths, no escapes, no secrets.

export interface FileOpResult {
  path: string
  operation: string
  ok: boolean
  reason?: string
  bytesWritten?: number
}

/** Read a file within the root for planning context (bounded). */
export function readWithinRoot(root: string, rel: string, maxBytes = 12_000): string | null {
  const check = checkWritePath(root, rel)
  if (!check.ok || !check.absolute || !existsSync(check.absolute)) return null
  try {
    return readFileSync(check.absolute, 'utf8').slice(0, maxBytes)
  } catch {
    return null
  }
}

/** Apply a single validated write (create/modify only). */
export function applyFileWrite(root: string, file: AgentActionFile): FileOpResult {
  if (file.operation === 'delete') {
    return { path: file.path, operation: 'delete', ok: false, reason: 'agents never delete files (propose-only)' }
  }
  const check = checkWritePath(root, file.path)
  if (!check.ok || !check.absolute) {
    return { path: file.path, operation: file.operation, ok: false, reason: check.reason }
  }
  if (typeof file.content !== 'string') {
    return { path: file.path, operation: file.operation, ok: false, reason: 'missing content' }
  }
  const bytes = Buffer.byteLength(file.content, 'utf8')
  if (bytes > 512 * 1024) {
    return { path: file.path, operation: file.operation, ok: false, reason: 'file too large (>512KB)' }
  }
  try {
    mkdirSync(dirname(check.absolute), { recursive: true })
    writeFileSync(check.absolute, file.content, 'utf8')
    return { path: check.relativePath ?? file.path, operation: file.operation, ok: true, bytesWritten: bytes }
  } catch (err) {
    return { path: file.path, operation: file.operation, ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/** Validate a set of proposed writes without applying (for preview). */
export function previewWrites(root: string, files: AgentActionFile[]): FileOpResult[] {
  return files.map((f) => {
    if (f.operation === 'delete') return { path: f.path, operation: 'delete', ok: false, reason: 'delete proposed (agents never delete)' }
    const check = checkWritePath(root, f.path)
    return { path: check.relativePath ?? f.path, operation: f.operation, ok: check.ok, reason: check.reason }
  })
}

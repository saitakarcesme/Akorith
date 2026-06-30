import { checkWritePath } from './paths'

// Phase 47: shared validation for a model-proposed file patch (used by Loop and
// Agents). Caps file count + size, validates every path against the root, and
// gates deletes. Returns per-file verdicts so the UI can preview them.

export type PatchOperation = 'create' | 'modify' | 'delete'

export interface PatchFile {
  operation: PatchOperation
  path: string
  content?: string
}

export interface PatchFileVerdict {
  operation: PatchOperation
  path: string
  ok: boolean
  reason?: string
  absolute?: string
  bytes: number
}

export interface PatchValidation {
  ok: boolean
  files: PatchFileVerdict[]
  reason?: string
}

export interface PatchLimits {
  maxFiles: number
  maxBytesPerFile: number
  maxTotalBytes: number
  allowDelete: boolean
}

export const DEFAULT_PATCH_LIMITS: PatchLimits = {
  maxFiles: 40,
  maxBytesPerFile: 256 * 1024,
  maxTotalBytes: 2 * 1024 * 1024,
  allowDelete: false
}

export function validatePatch(root: string, files: PatchFile[], limits: PatchLimits = DEFAULT_PATCH_LIMITS): PatchValidation {
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: false, files: [], reason: 'patch has no files' }
  }
  if (files.length > limits.maxFiles) {
    return { ok: false, files: [], reason: `patch has too many files (${files.length} > ${limits.maxFiles})` }
  }

  const verdicts: PatchFileVerdict[] = []
  let total = 0
  for (const file of files) {
    const op = file.operation
    const bytes = typeof file.content === 'string' ? Buffer.byteLength(file.content, 'utf8') : 0
    const base: PatchFileVerdict = { operation: op, path: String(file.path ?? ''), ok: false, bytes }

    if (op !== 'create' && op !== 'modify' && op !== 'delete') {
      verdicts.push({ ...base, reason: `invalid operation "${op}"` })
      continue
    }
    if (op === 'delete' && !limits.allowDelete) {
      verdicts.push({ ...base, reason: 'deletes are not allowed at this safety level' })
      continue
    }
    const path = checkWritePath(root, file.path)
    if (!path.ok) {
      verdicts.push({ ...base, reason: path.reason })
      continue
    }
    if (op !== 'delete' && typeof file.content !== 'string') {
      verdicts.push({ ...base, reason: 'missing file content' })
      continue
    }
    if (bytes > limits.maxBytesPerFile) {
      verdicts.push({ ...base, reason: `file too large (${bytes} > ${limits.maxBytesPerFile} bytes)` })
      continue
    }
    total += bytes
    verdicts.push({ ...base, ok: true, absolute: path.absolute, path: path.relativePath ?? base.path })
  }

  if (total > limits.maxTotalBytes) {
    return { ok: false, files: verdicts, reason: `patch too large overall (${total} > ${limits.maxTotalBytes} bytes)` }
  }
  const ok = verdicts.every((v) => v.ok)
  return { ok, files: verdicts, reason: ok ? undefined : 'one or more files failed validation' }
}

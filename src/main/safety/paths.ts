import { isAbsolute, relative, resolve, sep, basename } from 'path'

// Phase 47: shared path-safety primitives for Loop and Agents. Deterministic,
// in-code (never the model decides) — every file the model proposes is checked
// against the selected root before any write.

/** Secret-ish files we never create/modify (prefer .example where relevant). */
const SECRET_BASENAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  'id_rsa',
  'id_ed25519',
  'id_dsa',
  '.npmrc',
  '.netrc',
  'credentials',
  'secrets.json',
  '.pypirc'
])

/** Path segments that must never appear in a write target. */
const FORBIDDEN_SEGMENTS = new Set(['.git', '.ssh', '.gnupg', 'node_modules'])

export interface PathCheck {
  ok: boolean
  /** Resolved absolute path when ok. */
  absolute?: string
  /** Path relative to the root (posix-style) when ok. */
  relativePath?: string
  reason?: string
}

/** Is this basename a secret/credential file we refuse to write? */
export function isSecretFile(p: string): boolean {
  const base = basename(p).toLowerCase()
  if (SECRET_BASENAMES.has(base)) return true
  if (base.endsWith('.pem') || base.endsWith('.key') || base.endsWith('.pfx') || base.endsWith('.p12')) return true
  return false
}

/**
 * Resolve `candidate` (expected relative) inside `root` and confirm it stays
 * within the root, is not absolute, has no `..` escape, no forbidden segment,
 * and is not a secret file. Returns the safe absolute + relative paths.
 */
export function checkWritePath(root: string, candidate: string): PathCheck {
  if (typeof candidate !== 'string' || !candidate.trim()) {
    return { ok: false, reason: 'empty path' }
  }
  const trimmed = candidate.trim()
  if (isAbsolute(trimmed)) return { ok: false, reason: 'absolute paths are not allowed' }
  if (/[\0\r\n]/.test(trimmed)) return { ok: false, reason: 'path contains control characters' }
  // Strip only a leading "./" (current-dir) — never "../" or a leading dot that
  // is part of a real dirname like ".git", so traversal/forbidden checks still fire.
  const cleaned = trimmed.replace(/^(?:\.\/)+/, '')
  if (!cleaned || cleaned === '.') return { ok: false, reason: 'path resolves to the root itself' }

  const rootResolved = resolve(root)
  const abs = resolve(rootResolved, cleaned)
  const rel = relative(rootResolved, abs)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, reason: 'path escapes the selected project root' }
  }
  const segments = rel.split(sep)
  if (segments.some((s) => FORBIDDEN_SEGMENTS.has(s))) {
    return { ok: false, reason: `path touches a protected directory (${segments.find((s) => FORBIDDEN_SEGMENTS.has(s))})` }
  }
  if (isSecretFile(abs)) {
    return { ok: false, reason: 'refusing to write a secret/credential file' }
  }
  return { ok: true, absolute: abs, relativePath: segments.join('/') }
}

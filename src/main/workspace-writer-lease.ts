import { realpathSync, statSync } from 'fs'
import { isAbsolute, resolve } from 'path'

export type WorkspaceWriterKind = 'workspace-chat' | 'workspace-loop'

export interface WorkspaceWriterOwner {
  kind: WorkspaceWriterKind
  id: string
  label: string
}

export interface WorkspaceWriterLease {
  readonly workspacePath: string
  readonly owner: Readonly<WorkspaceWriterOwner>
  readonly acquiredAt: number
  release(): void
}

type LeaseEntry = {
  workspacePath: string
  owner: Readonly<WorkspaceWriterOwner>
  acquiredAt: number
  token: symbol
}

const leases = new Map<string, LeaseEntry>()

function leaseKey(canonicalPath: string): string {
  return process.platform === 'win32' ? canonicalPath.toLowerCase() : canonicalPath
}

export function canonicalWorkspaceDirectory(path: string): string {
  if (typeof path !== 'string' || !isAbsolute(path)) {
    throw new Error('The selected project path is not absolute.')
  }
  const canonical = realpathSync.native(resolve(path))
  if (!statSync(canonical).isDirectory()) {
    throw new Error('The selected project path is not a directory.')
  }
  return canonical
}

export class WorkspaceWriterLeaseConflictError extends Error {
  readonly workspacePath: string
  readonly holder: Readonly<WorkspaceWriterOwner>

  constructor(workspacePath: string, holder: Readonly<WorkspaceWriterOwner>) {
    super(`Another Workspace task is already editing this project: ${holder.label}`)
    this.name = 'WorkspaceWriterLeaseConflictError'
    this.workspacePath = workspacePath
    this.holder = holder
  }
}

/**
 * Acquire the process-wide write lease for one canonical project directory.
 *
 * Acquisition is synchronous, so two IPC handlers cannot both pass it before
 * either owner is registered. Each returned handle owns a unique token and
 * release is idempotent; a stale handle can never release a newer owner's
 * lease.
 */
export function acquireWorkspaceWriterLease(
  workspacePath: string,
  owner: WorkspaceWriterOwner
): WorkspaceWriterLease {
  if (
    !owner ||
    (owner.kind !== 'workspace-chat' && owner.kind !== 'workspace-loop') ||
    typeof owner.id !== 'string' ||
    owner.id.length < 1 ||
    owner.id.length > 256 ||
    typeof owner.label !== 'string' ||
    owner.label.length < 1 ||
    owner.label.length > 500
  ) {
    throw new Error('invalid Workspace writer lease owner')
  }

  const canonicalPath = canonicalWorkspaceDirectory(workspacePath)
  const key = leaseKey(canonicalPath)
  const current = leases.get(key)
  if (current) {
    throw new WorkspaceWriterLeaseConflictError(current.workspacePath, current.owner)
  }

  const token = Symbol(owner.id)
  const acquiredAt = Date.now()
  const frozenOwner = Object.freeze({ ...owner })
  leases.set(key, {
    workspacePath: canonicalPath,
    owner: frozenOwner,
    acquiredAt,
    token
  })

  let released = false
  return Object.freeze({
    workspacePath: canonicalPath,
    owner: frozenOwner,
    acquiredAt,
    release(): void {
      if (released) return
      released = true
      const active = leases.get(key)
      if (active?.token === token) leases.delete(key)
    }
  })
}

/** Read-only diagnostics used by verification and actionable conflict UI. */
export function workspaceWriterLeaseHolder(workspacePath: string): Readonly<WorkspaceWriterOwner> | null {
  const canonicalPath = canonicalWorkspaceDirectory(workspacePath)
  return leases.get(leaseKey(canonicalPath))?.owner ?? null
}

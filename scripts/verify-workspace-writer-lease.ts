import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireWorkspaceWriterLease,
  WorkspaceWriterLeaseConflictError,
  workspaceWriterLeaseHolder,
  type WorkspaceWriterLease
} from '../src/main/workspace-writer-lease'

const failures: string[] = []

function check(value: unknown, label: string): void {
  if (value) {
    console.log(`[ok] ${label}`)
    return
  }
  failures.push(label)
  console.error(`[fail] ${label}`)
}

async function main(): Promise<void> {
  const tempRoot = mkdtempSync(join(tmpdir(), 'akorith-writer-lease-'))
  const workspace = join(tempRoot, 'project')
  mkdirSync(workspace)

  try {
    const attempts = await Promise.all(
      [
        { kind: 'workspace-chat' as const, id: 'chat-race', label: 'ordinary Workspace request' },
        { kind: 'workspace-loop' as const, id: 'loop-race', label: 'durable /loop goal' }
      ].map(async (owner) => {
        await Promise.resolve()
        try {
          return { owner, lease: acquireWorkspaceWriterLease(join(workspace, '.'), owner) }
        } catch (error) {
          return { owner, error }
        }
      })
    )

    const winners = attempts.filter(
      (attempt): attempt is { owner: (typeof attempts)[number]['owner']; lease: WorkspaceWriterLease } =>
        'lease' in attempt
    )
    const losers = attempts.filter((attempt) => 'error' in attempt)
    check(
      winners.length === 1 &&
        losers.length === 1 &&
        losers[0]?.error instanceof WorkspaceWriterLeaseConflictError,
      'simultaneous chat and /loop contenders produce exactly one canonical-path writer'
    )

    const winner = winners[0]
    check(
      Boolean(winner) && workspaceWriterLeaseHolder(workspace)?.id === winner.owner.id,
      'the winning owner is visible while its lease is active'
    )

    winner?.lease.release()
    const replacement = acquireWorkspaceWriterLease(workspace, {
      kind: 'workspace-loop',
      id: 'replacement-loop',
      label: 'replacement /loop goal'
    })
    winner?.lease.release()
    check(
      workspaceWriterLeaseHolder(workspace)?.id === 'replacement-loop',
      'release is idempotent and a stale handle cannot release a newer lease'
    )

    replacement.release()
    replacement.release()
    check(
      workspaceWriterLeaseHolder(workspace) === null,
      'the canonical workspace becomes available after the active owner releases'
    )
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }

  if (failures.length > 0) {
    console.error(`\nWorkspace writer lease verification failed (${failures.length}).`)
    process.exit(1)
  }
  console.log('\nWorkspace writer lease verification passed.')
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})

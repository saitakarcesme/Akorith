import type { ChatSendResult, GitChangeFile, GitStatusResult } from '../../preload/index.d'

export type WorkspaceChanges = NonNullable<ChatSendResult['changes']>

function filesFrom(result: GitStatusResult | null): GitChangeFile[] | null {
  return result?.ok && result.isRepo ? result.files : null
}

function signature(file: GitChangeFile): string {
  return `${file.status}:${file.staged ? 1 : 0}:${file.additions}:${file.deletions}`
}

/** Returns only working-tree entries that changed after this Workspace turn began. */
export function liveWorkspaceChangesSince(
  before: GitStatusResult | null,
  after: GitStatusResult
): WorkspaceChanges | undefined {
  const baselineFiles = filesFrom(before)
  if (!baselineFiles || !after.ok || !after.isRepo) return undefined
  const currentFiles = after.files

  const baseline = new Map(baselineFiles.map((file) => [file.path, signature(file)]))
  const files = currentFiles.filter((file) => baseline.get(file.path) !== signature(file))
  if (files.length === 0) return undefined
  return {
    files,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    truncated: after.truncated
  }
}

export function newlyCreatedWorkspaceFiles(changes: WorkspaceChanges): string[] {
  return changes.files
    .filter((file) => file.status.includes('?') || file.status.includes('A'))
    .map((file) => file.path)
}

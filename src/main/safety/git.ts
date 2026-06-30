// Phase 47: git-specific safety. Push is NEVER allowed unless a loop/agent has
// pushEnabled explicitly set; force-push and history rewrites are always denied.

export interface GitOpCheck {
  ok: boolean
  reason?: string
}

const ALWAYS_DENIED: RegExp[] = [
  /--force\b/i,
  /-f\b/i,
  /\bpush\s+--force/i,
  /\breset\s+--hard/i,
  /\bclean\s+-[a-z]*f/i,
  /\brebase\b/i,
  /\bfilter-branch\b/i,
  /\bfilter-repo\b/i,
  /\bpush\s+.*:.*--delete/i,
  /\bremote\s+(add|set-url|remove)/i // a loop never reconfigures remotes
]

/** Validate a git push request. Push requires explicit opt-in and is never forced. */
export function checkGitPush(pushEnabled: boolean, rawArgs: string): GitOpCheck {
  if (!pushEnabled) return { ok: false, reason: 'push is disabled for this loop (pushEnabled is false)' }
  for (const pat of ALWAYS_DENIED) {
    if (pat.test(rawArgs)) return { ok: false, reason: `forbidden git option (${pat.source})` }
  }
  return { ok: true }
}

/** Validate a non-push git command a loop/agent wants to run on its own repo. */
export function checkGitCommand(rawArgs: string): GitOpCheck {
  for (const pat of ALWAYS_DENIED) {
    if (pat.test(rawArgs)) return { ok: false, reason: `forbidden git option (${pat.source})` }
  }
  return { ok: true }
}

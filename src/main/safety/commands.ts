// Phase 47: shared command-safety primitives for Loop and Agents. Only a small
// allowlist of read-only / validation commands may run; anything destructive,
// network-installing, privilege-changing, or pushing is rejected in code.

/** Command prefixes that are allowed (validation / inspection only). */
const ALLOWED_PREFIXES = [
  'npm run typecheck',
  'npm run build',
  'npm run lint',
  'npm test',
  'npm run test',
  'npx tsc',
  'tsc --noEmit',
  'node --check',
  'pytest',
  'python -m pytest',
  'go build',
  'go test',
  'cargo check',
  'cargo build',
  'cargo test',
  'git status',
  'git diff',
  'git log',
  'git add',
  'git commit',
  'ls',
  'cat'
]

/** Hard denials — never allowed even if a prefix matched. */
const FORBIDDEN_PATTERNS: RegExp[] = [
  /\brm\s+-[a-z]*r/i, // rm -r / rm -rf
  /\brmdir\b/i,
  /\bgit\s+push\b/i, // push is gated separately (pushEnabled), never via the allowlist
  /\bgit\s+reset\s+--hard/i,
  /\bgit\s+clean\s+-[a-z]*f/i,
  /\bgit\s+checkout\s+--\s/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bsudo\b/i,
  /\bcurl\b/i,
  /\bwget\b/i,
  /\bnpm\s+(i|install|ci|add)\b/i, // no dependency installs from a loop/agent
  /\byarn\s+(add|install)\b/i,
  /\bpnpm\s+(add|install)\b/i,
  /\bpip\s+install\b/i,
  /\bbrew\s+install\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /[;&|`$]/, // no chaining/substitution/redirection
  /\.\./ // no parent-dir traversal in a command
]

export interface CommandCheck {
  ok: boolean
  reason?: string
}

export function checkCommand(cmd: string): CommandCheck {
  if (typeof cmd !== 'string' || !cmd.trim()) return { ok: false, reason: 'empty command' }
  const trimmed = cmd.trim()
  if (trimmed.length > 400) return { ok: false, reason: 'command too long' }
  if (/[\0\r\n]/.test(trimmed)) return { ok: false, reason: 'command contains control characters' }

  for (const pat of FORBIDDEN_PATTERNS) {
    if (pat.test(trimmed)) return { ok: false, reason: `command rejected by safety policy (${pat.source})` }
  }
  const allowed = ALLOWED_PREFIXES.some((p) => trimmed === p || trimmed.startsWith(p + ' '))
  if (!allowed) return { ok: false, reason: 'command is not on the validation allowlist' }
  return { ok: true }
}

export function allowedCommandPrefixes(): readonly string[] {
  return ALLOWED_PREFIXES
}

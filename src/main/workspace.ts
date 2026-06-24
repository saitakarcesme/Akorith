// Phase 20: autonomous workspace loop.
//
// Turns the macro loop into a "loop-commit projects system": scaffold an
// everyday-dev project (its own git repo), let the macro loop build it, and
// commit EVERY graded change as "Phase N: <change>" — stopping when the metered
// meta-call token budget is spent. Commits are loop-driven (deterministic git),
// never left to the executor agent to remember. Commit messages are passed via
// stdin (`git commit -F -`) so untrusted headlines never touch the shell args.
//
// Pure helpers here are headlessly verified by scripts/verify-workspace-loop.ts
// (which also drives the real git helpers against a throwaway repo).

import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { mkdir, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { basename, dirname, join } from 'path'

const GIT_TIMEOUT_MS = 20_000
const HEADLINE_MAX = 72
export const LOOP_REPOSITORY_URL = 'https://github.com/saitakarcesme/AkorithLoop.git'
export const LOOP_REPOSITORY_BRANCH = 'main'
let loopGitQueue: Promise<void> = Promise.resolve()
// Fixed identity so commits work in a headless/first-run environment without
// mutating the user's global git config. These are constants, never user input.
const GIT_IDENTITY = ['-c', 'user.name=Akorith', '-c', 'user.email=akorith@local']

// ---------- pure helpers (no IO) ----------

// Matches our own "Phase 12", "Phase 18.2:", etc. so numbering continues a repo.
const PHASE_RE = /^Phase\s+(\d+)(?:\.\d+)?\s*:/i

/** Highest "Phase N" number among commit subjects (0 when none). */
export function parseHighestPhase(subjects: string[]): number {
  let max = 0
  for (const raw of subjects) {
    const m = PHASE_RE.exec(raw.trim())
    if (m) max = Math.max(max, Number.parseInt(m[1], 10))
  }
  return max
}

/** One-line, length-bounded "Phase N: headline" commit subject. */
export function buildPhaseCommitMessage(phase: number, headline: string): string {
  const clean = headline.replace(/\s+/g, ' ').trim().slice(0, HEADLINE_MAX) || 'autonomous change'
  return `Phase ${phase}: ${clean}`
}

/**
 * Derive a short commit headline from the loop's own grading of a turn. Prefers
 * the critic's verdict/rationale, falls back to the summary status, then a
 * generic label — so a commit subject is always meaningful and never empty.
 */
export function deriveHeadline(input: {
  criticRationale?: string | null
  criticVerdict?: string | null
  summaryStatus?: string | null
  goal?: string | null
}): string {
  const firstSentence = (s: string): string => (s.split(/(?<=[.!?])\s/)[0] ?? s).trim()
  const fromCritic = input.criticRationale?.trim() ? firstSentence(input.criticRationale) : ''
  const fromSummary = input.summaryStatus?.trim() ? firstSentence(input.summaryStatus) : ''
  const base = fromCritic || fromSummary || (input.goal ? `work toward ${input.goal}` : '') || 'autonomous change'
  return base.replace(/\s+/g, ' ').trim().slice(0, HEADLINE_MAX)
}

/** Filesystem-safe slug for a generated project directory name. */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'akorith-project'
  )
}

export interface ProjectIdea {
  name: string
  slug: string
  summary: string
  firstGoal: string
}

/** Meta prompt that asks a model to invent an everyday-developer project idea. */
export function buildIdeaPrompt(seed?: string): string {
  const hint = seed?.trim() ? `\n\nLean toward this theme if it is reasonable: ${seed.trim()}` : ''
  return `You are Akorith's project idea generator. Invent ONE small, genuinely useful "everyday developer" project that a coding agent can build incrementally from an empty git repository — a CLI tool, a small library, or a tiny local web app. Keep it buildable in many small commits.${hint}

Return ONLY JSON in this schema (no prose):
{
  "name": "short human project name",
  "slug": "kebab-case-folder-name",
  "summary": "one or two sentences on what it does and why it is useful",
  "first_goal": "the concrete first development goal for the build loop, phrased as an instruction to a coding agent working in an empty repo"
}`
}

/** Parse the idea JSON; returns null if unusable so the caller can fall back. */
export function parseProjectIdea(text: string): ProjectIdea | null {
  try {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
    const body = fenced ? fenced[1] : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
    const p = JSON.parse(body) as Record<string, unknown>
    const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 80) : ''
    const summary = typeof p.summary === 'string' ? p.summary.trim().slice(0, 600) : ''
    const firstGoal = typeof p.first_goal === 'string' ? p.first_goal.trim().slice(0, 4000) : ''
    if (!name || !firstGoal) return null
    const slug = slugify(typeof p.slug === 'string' && p.slug.trim() ? p.slug : name)
    return { name, slug, summary, firstGoal }
  } catch {
    return null
  }
}

// ---------- git IO helpers ----------

interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
}

/**
 * Run git directly (shell:false, args array) so a commit headline passed via
 * `-F -` over stdin can never be interpreted by a shell. Self-contained (only
 * node builtins) so it stays headlessly verifiable.
 */
function git(cwd: string, args: string[], stdin?: string): Promise<GitResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (res: GitResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(res)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('git', args, { cwd, windowsHide: true })
    } catch (err) {
      return finish({ ok: false, stdout: '', stderr: err instanceof Error ? err.message : String(err) })
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
      finish({ ok: false, stdout: stdout.trim(), stderr: 'git timed out' })
    }, GIT_TIMEOUT_MS)
    child.stdout?.on('data', (d) => (stdout += d.toString()))
    child.stderr?.on('data', (d) => (stderr += d.toString()))
    child.on('error', (err) => finish({ ok: false, stdout: '', stderr: err.message }))
    child.on('close', (code) => finish({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() }))
    child.stdin?.end(stdin ?? '')
  })
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  if (!existsSync(cwd)) return false
  const res = await git(cwd, ['rev-parse', '--is-inside-work-tree'])
  return res.ok && res.stdout === 'true'
}

/** True when the worktree has any staged or unstaged change (porcelain). */
export async function hasChanges(cwd: string): Promise<boolean> {
  const res = await git(cwd, ['status', '--porcelain', '--', '.'])
  return res.ok && res.stdout.length > 0
}

/** Next "Phase N" number for this repo: highest existing phase + 1 (min 1). */
export async function nextPhaseNumber(cwd: string): Promise<number> {
  const res = await git(cwd, ['log', '--pretty=%s', '-n', '200', '--', '.'])
  if (!res.ok || !res.stdout) return 1
  return parseHighestPhase(res.stdout.split('\n')) + 1
}

async function configureLoopRemote(dir: string, repoUrl = LOOP_REPOSITORY_URL): Promise<GitResult> {
  const remote = await git(dir, ['remote', 'get-url', 'origin'])
  if (remote.ok) return git(dir, ['remote', 'set-url', 'origin', repoUrl])
  return git(dir, ['remote', 'add', 'origin', repoUrl])
}

async function ensureMainBranch(dir: string): Promise<void> {
  await git(dir, ['fetch', 'origin', LOOP_REPOSITORY_BRANCH])
  const local = await git(dir, ['rev-parse', '--verify', LOOP_REPOSITORY_BRANCH])
  const remote = await git(dir, ['rev-parse', '--verify', `origin/${LOOP_REPOSITORY_BRANCH}`])
  if (remote.ok) {
    await git(dir, ['checkout', '-B', LOOP_REPOSITORY_BRANCH, `origin/${LOOP_REPOSITORY_BRANCH}`])
  } else if (local.ok) {
    await git(dir, ['checkout', LOOP_REPOSITORY_BRANCH])
  } else {
    await git(dir, ['checkout', '-B', LOOP_REPOSITORY_BRANCH])
    await git(dir, ['symbolic-ref', 'HEAD', `refs/heads/${LOOP_REPOSITORY_BRANCH}`])
  }
}

/**
 * Ensure the shared AkorithLoop output repository exists locally. Every loop
 * workspace is a subfolder inside this one repo, so all loop commits and pushes
 * land in the same GitHub history instead of isolated throwaway repos.
 */
export async function ensureLoopRepository(dir: string, repoUrl = LOOP_REPOSITORY_URL): Promise<InitResult> {
  try {
    const parent = dirname(dir)
    await mkdir(parent, { recursive: true })
    if (!existsSync(join(dir, '.git'))) {
      if (!existsSync(dir)) {
        const clone = await git(parent, ['clone', repoUrl, basename(dir)])
        if (!clone.ok) return { ok: false, dir, error: `git clone failed: ${clone.stderr || clone.stdout}` }
      }
      if (!existsSync(join(dir, '.git'))) {
        await mkdir(dir, { recursive: true })
        const init = await git(dir, ['init'])
        if (!init.ok) return { ok: false, dir, error: `git init failed: ${init.stderr}` }
      }
    }
    const remote = await configureLoopRemote(dir, repoUrl)
    if (!remote.ok) return { ok: false, dir, error: `git remote failed: ${remote.stderr || remote.stdout}` }
    await ensureMainBranch(dir)
    await git(dir, ['pull', '--ff-only', 'origin', LOOP_REPOSITORY_BRANCH])
    return { ok: true, dir }
  } catch (err) {
    return { ok: false, dir, error: err instanceof Error ? err.message : String(err) }
  }
}

export function loopWorkspaceFolder(repoDir: string, slug: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').toLowerCase()
  return join(repoDir, `${slugify(slug)}-${stamp}-${randomUUID().slice(0, 8)}`)
}

export async function withLoopGitQueue<T>(work: () => Promise<T>): Promise<T> {
  const previous = loopGitQueue
  let release!: () => void
  loopGitQueue = new Promise((resolve) => {
    release = resolve
  })
  await previous
  try {
    return await work()
  } finally {
    release()
  }
}

export interface InitResult {
  ok: boolean
  dir: string
  error?: string
}

/**
 * Create `dir` (if absent), `git init` it, drop a README, and make the first
 * commit ("Phase 0: scaffold project") so the loop's Phase 1+ commits follow on.
 * No-ops cleanly if the directory is already a repo.
 */
export async function initWorkspace(dir: string, idea: ProjectIdea): Promise<InitResult> {
  try {
    await mkdir(dir, { recursive: true })
    if (!(await isGitRepo(dir))) {
      const init = await git(dir, ['init'])
      if (!init.ok) return { ok: false, dir, error: `git init failed: ${init.stderr}` }
      // Ensure a deterministic default branch name across git versions.
      await git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    }
    const readme = `# ${idea.name}\n\n${idea.summary}\n\n> Built autonomously by Akorith's macro loop. Each change is committed as \`Phase N: <change>\`.\n\n## First goal\n\n${idea.firstGoal}\n`
    await writeFile(join(dir, 'README.md'), readme, 'utf8')
    if (await hasChanges(dir)) {
      await git(dir, ['add', '-A', '--', '.'])
      await git(dir, [...GIT_IDENTITY, 'commit', '-F', '-'], 'Phase 0: scaffold project')
    }
    return { ok: true, dir }
  } catch (err) {
    return { ok: false, dir, error: err instanceof Error ? err.message : String(err) }
  }
}

export interface CommitResult {
  committed: boolean
  phase?: number
  message?: string
  reason?: string
}

/**
 * Stage everything and commit it as the next "Phase N: <headline>". Returns
 * committed:false (not an error) when there is nothing to commit, so the loop
 * can keep going without noise.
 */
export async function commitPhase(cwd: string, headline: string): Promise<CommitResult> {
  if (!(await isGitRepo(cwd))) return { committed: false, reason: 'not a git repository' }
  const add = await git(cwd, ['add', '-A', '--', '.'])
  if (!add.ok) return { committed: false, reason: `git add failed: ${add.stderr}` }
  if (!(await hasChanges(cwd))) return { committed: false, reason: 'no changes to commit' }
  const phase = await nextPhaseNumber(cwd)
  const message = buildPhaseCommitMessage(phase, headline)
  const commit = await git(cwd, [...GIT_IDENTITY, 'commit', '-F', '-'], message)
  if (!commit.ok) return { committed: false, reason: `git commit failed: ${commit.stderr}` }
  return { committed: true, phase, message }
}

export interface PushResult {
  pushed: boolean
  reason?: string
}

export async function syncWorkspace(cwd: string): Promise<PushResult> {
  if (!(await isGitRepo(cwd))) return { pushed: false, reason: 'not a git repository' }
  const pull = await git(cwd, ['pull', '--rebase', '--autostash', 'origin', LOOP_REPOSITORY_BRANCH])
  if (!pull.ok && !/couldn't find remote ref|no such ref|no tracking information/i.test(pull.stderr + pull.stdout)) {
    return { pushed: false, reason: `git pull failed: ${pull.stderr || pull.stdout}` }
  }
  return { pushed: true }
}

export async function pushWorkspace(cwd: string): Promise<PushResult> {
  if (!(await isGitRepo(cwd))) return { pushed: false, reason: 'not a git repository' }
  const push = await git(cwd, ['push', '-u', 'origin', `HEAD:${LOOP_REPOSITORY_BRANCH}`])
  if (!push.ok) return { pushed: false, reason: `git push failed: ${push.stderr || push.stdout}` }
  return { pushed: true }
}

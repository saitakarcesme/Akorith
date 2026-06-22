import { ipcMain } from 'electron'
import { accessSync, chmodSync, constants, existsSync, readdirSync, statSync } from 'fs'
import { homedir } from 'os'
import { delimiter, isAbsolute, join } from 'path'
import { spawn, type IPty } from 'node-pty'

// Terminal ids are renderer-supplied. Logical ids ("t1", "t2") may be suffixed
// with a sanitized per-project key ("t1::<projectId>") so each project keeps
// its own live session. Keep the accepted shape narrow; do not accept arbitrary
// colon-delimited strings.
const VALID_ID = /^[a-z0-9-]{1,32}(::[a-z0-9-]{1,40})?$/
const VALID_PROJECT_KEY = /^[a-z0-9-]{1,40}$/

export interface PtyCreateOptions {
  cols: number
  rows: number
  cwd?: string
  commandKind?: PtyCommandKind
}

// `*-auto` kinds launch the agent CLI in non-interactive / bypass-permission
// mode, used by the autonomous Loop section so it never stops to ask. The plain
// kinds keep their normal interactive prompts for the user-driven workspace.
export type PtyCommandKind = 'shell' | 'codex' | 'claude' | 'claude-auto' | 'codex-auto'

export type PtyCreateResponse =
  | { ok: true; started: PtyCommandKind; fallback?: boolean; message?: string; reused?: boolean }
  | { ok: false; error: string }

function clampDimension(value: unknown, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(Math.max(n, 2), 500)
}

let cachedShell: string | null = null
let spawnHelperChecked = false

function ensureSpawnHelperExecutable(): void {
  if (spawnHelperChecked || process.platform !== 'darwin') return
  spawnHelperChecked = true

  const prebuildsDir = join(__dirname, '..', '..', 'node_modules', 'node-pty', 'prebuilds')
  try {
    for (const entry of readdirSync(prebuildsDir)) {
      if (!entry.startsWith('darwin-')) continue
      const helper = join(prebuildsDir, entry, 'spawn-helper')
      const stat = statSync(helper)
      if ((stat.mode & 0o111) === 0) {
        chmodSync(helper, stat.mode | 0o755)
      }
    }
  } catch {
    // If the layout changes, node-pty's spawn failure will still surface clearly.
  }
}

function resolveDefaultShell(): string {
  if (cachedShell) return cachedShell
  if (process.platform === 'win32') {
    // Prefer PowerShell 7 (pwsh) when it is on PATH, else Windows PowerShell.
    cachedShell = 'powershell.exe'
    for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
      if (dir && existsSync(join(dir, 'pwsh.exe'))) {
        cachedShell = join(dir, 'pwsh.exe')
        break
      }
    }
  } else {
    cachedShell = process.env['SHELL'] ?? '/bin/bash'
  }
  return cachedShell
}

function safeCwd(cwd: unknown): string | null {
  if (cwd === undefined || cwd === null || cwd === '') return homedir()
  if (typeof cwd !== 'string' || cwd.length > 2_000 || /[\0\r\n]/.test(cwd)) return null
  if (!isAbsolute(cwd)) return null
  try {
    return statSync(cwd).isDirectory() ? cwd : null
  } catch {
    return null
  }
}

function resolveExecutable(command: 'codex' | 'claude'): string | null {
  const pathDirs = (process.env['PATH'] ?? '').split(delimiter).filter(Boolean)
  const suffixes =
    process.platform === 'win32'
      ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : ['']
  for (const dir of pathDirs) {
    for (const suffix of suffixes) {
      const candidate = join(dir, process.platform === 'win32' ? `${command}${suffix}` : command)
      try {
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        // Keep scanning PATH.
      }
    }
  }
  return null
}

function commandSpec(kind: PtyCommandKind): { command: string; args: string[]; started: PtyCommandKind; message?: string } {
  if (kind === 'codex' || kind === 'claude' || kind === 'claude-auto' || kind === 'codex-auto') {
    const base = kind === 'codex' || kind === 'codex-auto' ? 'codex' : 'claude'
    const resolved = resolveExecutable(base)
    if (resolved) {
      // Loop's autonomous executor: skip interactive permission/approval prompts.
      const args =
        kind === 'claude-auto'
          ? ['--dangerously-skip-permissions']
          : kind === 'codex-auto'
            ? ['--dangerously-bypass-approvals-and-sandbox']
            : []
      return { command: resolved, args, started: kind }
    }
    const label = base === 'codex' ? 'Codex' : 'Claude'
    return {
      command: resolveDefaultShell(),
      args: [],
      started: 'shell',
      message: `[akorith] ${label} CLI was not found on PATH. Started a shell in the project folder instead.\r\n`
    }
  }
  return { command: resolveDefaultShell(), args: [], started: 'shell' }
}

/**
 * Owns every PTY in the app. Sessions are keyed by terminal id and fully
 * independent — data and exit events are routed back only to the WebContents
 * that created the session, tagged with that id.
 */
interface Session {
  pty: IPty
  /** Bounded ring of recent raw output for read-only snapshots (Phase 11). */
  buffer: string
  /** The command kind that actually started (codex/claude/shell) for reuse reports. */
  started: PtyCommandKind
  /** Requested cwd/kind, used to avoid reusing a live session after project metadata changes. */
  cwd: string
  requestedKind: PtyCommandKind
}

// Hard cap on retained scrollback per terminal — keeps memory bounded.
const MAX_BUFFER_CHARS = 120_000
// Keep live agent sessions for enough recent projects/loops to support the
// Loop Operations Center. Earlier phases used 3 for the interactive workspace,
// but 10 active autonomous loops need their own PTYs alive at the same time.
const MAX_LIVE_PROJECTS = 20

interface PtySink {
  isDestroyed(): boolean
  send(channel: string, payload: unknown): void
}

const HEADLESS_SINK: PtySink = {
  isDestroyed: () => false,
  send: () => undefined
}

export interface PtySnapshot {
  id: string
  alive: boolean
  /** Raw (still ANSI-bearing) tail of recent output, bounded by maxChars. */
  text: string
  chars: number
  truncated: boolean
}

class PtyManager {
  private readonly sessions = new Map<string, Session>()
  /** Logical bridge target ("t1"/"t2") resolves to the active project's session. */
  private activeProjectKey = ''
  /** Recency-ordered project keys for bounded eviction (oldest first). */
  private projectOrder: string[] = []

  /** Composite-key suffix for a project ("t1" → "t1::<key>"). */
  private projectKeyOf(id: string): string | null {
    const at = id.indexOf('::')
    if (at === -1) return null
    const key = id.slice(at + 2)
    return VALID_PROJECT_KEY.test(key) ? key : null
  }

  /**
   * Resolve a logical id ("t1"/"t2") to a concrete session key. If the exact id
   * already names a live session (renderer passes the composite id), use it;
   * otherwise bind it to the active project's session (bridge/snapshot use this).
   */
  private resolve(id: string): string {
    if (this.sessions.has(id)) return id
    if (id.includes('::')) return id
    return this.activeProjectKey ? `${id}::${this.activeProjectKey}` : id
  }

  setActiveProject(projectKey: string): void {
    this.activeProjectKey = projectKey
  }

  create(id: string, options: PtyCreateOptions, sink: PtySink): PtyCreateResponse {
    const cwd = safeCwd(options.cwd)
    if (!cwd) return { ok: false, error: 'invalid terminal working directory' }
    const kind = options.commandKind ?? 'shell'

    // Phase 13.3: reuse an already-live session (e.g. switching back to a project)
    // instead of killing + respawning — this preserves the running agent.
    const existing = this.sessions.get(id)
    if (existing) {
      if (existing.cwd !== cwd || existing.requestedKind !== kind) {
        this.kill(id)
      } else {
        this.touchProject(this.projectKeyOf(id))
        return { ok: true, started: existing.started, reused: true }
      }
    }

    const spec = commandSpec(kind)

    let pty: IPty
    try {
      ensureSpawnHelperExecutable()
      pty = spawn(spec.command, spec.args, {
        name: 'xterm-color',
        cols: clampDimension(options.cols, 80),
        rows: clampDimension(options.rows, 24),
        cwd,
        env: process.env as Record<string, string>
        // useConpty is left to node-pty's auto-detection: ConPTY on Win10 1809+,
        // winpty fallback on anything older.
      })
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }

    const session: Session = { pty, buffer: '', started: spec.started, cwd, requestedKind: kind }
    this.sessions.set(id, session)
    this.touchProject(this.projectKeyOf(id))

    // A killed session can keep emitting until ConPTY tears it down, after a
    // replacement session has already claimed this id. Guard every event with
    // an identity check so a predecessor can never speak for — or evict — the
    // current session.
    pty.onData((data) => {
      if (this.sessions.get(id) !== session) return
      // Retain a bounded tail for read-only snapshots (Phase 11 agentic loop).
      session.buffer = (session.buffer + data).slice(-MAX_BUFFER_CHARS)
      if (!sink.isDestroyed()) sink.send('pty:data', { id, data })
    })
    pty.onExit(({ exitCode }) => {
      if (this.sessions.get(id) !== session) return
      this.sessions.delete(id)
      this.removeProjectIfEmpty(this.projectKeyOf(id))
      if (!sink.isDestroyed()) sink.send('pty:exit', { id, code: exitCode })
    })
    return {
      ok: true,
      started: spec.started,
      fallback: spec.started !== kind,
      message: spec.message
    }
  }

  /** Start/reuse a PTY owned by the loop runtime rather than a visible xterm. */
  createHeadless(id: string, options: PtyCreateOptions): PtyCreateResponse {
    return this.create(id, options, HEADLESS_SINK)
  }

  /**
   * The single entry point for sending text/keystrokes into a terminal.
   * Anything that wants to put bytes in front of the shell — a human typing
   * in xterm or a programmatic caller — must go through here.
   *
   * TODO(phase 4): the chat→terminal prompt bridge calls this with the
   *                planner's prompt text.
   * Phase 9: the semi-automatic macro-loop reaches this only through
   * bridgeSend() after user approval.
   */
  write(id: string, data: string): void {
    this.sessions.get(this.resolve(id))?.pty.write(data)
  }

  /** Whether a live session exists for this terminal id (logical → active project). */
  isAlive(id: string): boolean {
    return this.sessions.has(this.resolve(id))
  }

  /** Mark a project most-recently-used and evict the oldest beyond the cap. */
  private touchProject(projectKey: string | null): void {
    if (!projectKey) return
    this.projectOrder = this.projectOrder.filter((k) => k !== projectKey)
    this.projectOrder.push(projectKey)
    while (this.projectOrder.length > MAX_LIVE_PROJECTS) {
      const evicted = this.projectOrder.shift()
      if (!evicted) break
      for (const sid of [...this.sessions.keys()]) {
        if (sid.endsWith(`::${evicted}`)) this.kill(sid)
      }
    }
  }

  private removeProjectIfEmpty(projectKey: string | null): void {
    if (!projectKey) return
    if ([...this.sessions.keys()].some((sid) => sid.endsWith(`::${projectKey}`))) return
    this.projectOrder = this.projectOrder.filter((k) => k !== projectKey)
  }

  /**
   * Read-only bounded snapshot of recent terminal output. Returns the raw tail
   * (still ANSI-bearing); cleaning/parsing happens in agentic-core. This never
   * writes to the PTY, exposes no filesystem, and runs no command — it only
   * reads the in-memory ring this manager already keeps.
   */
  snapshot(id: string, maxChars = 8000): PtySnapshot {
    const session = this.sessions.get(this.resolve(id))
    const cap = Math.min(Math.max(Math.floor(maxChars) || 0, 1), MAX_BUFFER_CHARS)
    if (!session) return { id, alive: false, text: '', chars: 0, truncated: false }
    const full = session.buffer
    const text = full.slice(-cap)
    return { id, alive: true, text, chars: text.length, truncated: full.length > text.length }
  }

  resize(id: string, cols: number, rows: number): void {
    this.sessions.get(this.resolve(id))?.pty.resize(clampDimension(cols, 80), clampDimension(rows, 24))
  }

  kill(id: string): void {
    const resolved = this.resolve(id)
    const session = this.sessions.get(resolved)
    if (!session) return
    // Delete first: this marks the session superseded, so its (asynchronous,
    // ConPTY-driven) exit event is suppressed rather than misattributed.
    this.sessions.delete(resolved)
    this.removeProjectIfEmpty(this.projectKeyOf(resolved))
    try {
      session.pty.kill()
    } catch {
      // Already dead (ConPTY can throw if the process exited first) — fine.
    }
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id)
  }
}

export const ptyManager = new PtyManager()

export function registerPtyIpc(): void {
  const VALID_KINDS = new Set<string>(['shell', 'codex', 'claude', 'claude-auto', 'codex-auto'])
  ipcMain.handle('pty:create', (event, args: { id: string } & PtyCreateOptions): PtyCreateResponse => {
    if (
      typeof args?.id !== 'string' ||
      !VALID_ID.test(args.id) ||
      (args.commandKind !== undefined && !VALID_KINDS.has(args.commandKind))
    ) {
      return { ok: false, error: 'invalid pty:create payload' }
    }
    return ptyManager.create(args.id, args, event.sender)
  })

  ipcMain.on('pty:input', (_event, args: { id: string; data: string }) => {
    if (typeof args?.id !== 'string' || !VALID_ID.test(args.id)) return
    if (typeof args.data !== 'string') return
    ptyManager.write(args.id, args.data)
  })

  ipcMain.on('pty:resize', (_event, args: { id: string; cols: number; rows: number }) => {
    if (typeof args?.id !== 'string' || !VALID_ID.test(args.id)) return
    ptyManager.resize(args.id, args.cols, args.rows)
  })

  ipcMain.on('pty:kill', (_event, args: { id: string }) => {
    if (typeof args?.id !== 'string' || !VALID_ID.test(args.id)) return
    ptyManager.kill(args.id)
  })

  // Phase 13.3: tell the manager which project's session the logical bridge
  // targets ("t1"/"t2") resolve to. Empty string clears (no active project).
  ipcMain.on('pty:setActiveProject', (_event, args: { projectKey: string }) => {
    if (typeof args?.projectKey !== 'string') return
    if (args.projectKey !== '' && !VALID_PROJECT_KEY.test(args.projectKey)) return
    ptyManager.setActiveProject(args.projectKey)
  })

  // Read-only output snapshot. Bounded; no write/exec/filesystem surface.
  ipcMain.handle('pty:snapshot', (_event, args: { id: string; maxChars?: number }): PtySnapshot => {
    if (typeof args?.id !== 'string' || !VALID_ID.test(args.id)) {
      return { id: '', alive: false, text: '', chars: 0, truncated: false }
    }
    const maxChars = typeof args.maxChars === 'number' && Number.isFinite(args.maxChars) ? args.maxChars : 8000
    return ptyManager.snapshot(args.id, maxChars)
  })
}

import { ipcMain, type WebContents } from 'electron'
import { accessSync, constants, existsSync, statSync } from 'fs'
import { homedir } from 'os'
import { delimiter, isAbsolute, join } from 'path'
import { spawn, type IPty } from 'node-pty'

// Terminal ids are renderer-supplied; accept only short slugs ("t1", "t2", ...).
const VALID_ID = /^[a-z0-9-]{1,32}$/

export interface PtyCreateOptions {
  cols: number
  rows: number
  cwd?: string
  commandKind?: PtyCommandKind
}

export type PtyCommandKind = 'shell' | 'codex' | 'claude'

export type PtyCreateResponse =
  | { ok: true; started: PtyCommandKind; fallback?: boolean; message?: string }
  | { ok: false; error: string }

function clampDimension(value: unknown, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(Math.max(n, 2), 500)
}

let cachedShell: string | null = null

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
  if (kind === 'codex' || kind === 'claude') {
    const resolved = resolveExecutable(kind)
    if (resolved) return { command: resolved, args: [], started: kind }
    const label = kind === 'codex' ? 'Codex' : 'Claude'
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
}

class PtyManager {
  private readonly sessions = new Map<string, Session>()

  create(id: string, options: PtyCreateOptions, sink: WebContents): PtyCreateResponse {
    const cwd = safeCwd(options.cwd)
    if (!cwd) return { ok: false, error: 'invalid terminal working directory' }
    const kind = options.commandKind ?? 'shell'
    const spec = commandSpec(kind)

    // Replace any stale session with the same id (e.g. a remounted pane) only
    // after the new lifecycle request has passed validation.
    this.kill(id)

    let pty: IPty
    try {
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

    const session: Session = { pty }
    this.sessions.set(id, session)

    // A killed session can keep emitting until ConPTY tears it down, after a
    // replacement session has already claimed this id. Guard every event with
    // an identity check so a predecessor can never speak for — or evict — the
    // current session.
    pty.onData((data) => {
      if (this.sessions.get(id) !== session) return
      if (!sink.isDestroyed()) sink.send('pty:data', { id, data })
    })
    pty.onExit(({ exitCode }) => {
      if (this.sessions.get(id) !== session) return
      this.sessions.delete(id)
      if (!sink.isDestroyed()) sink.send('pty:exit', { id, code: exitCode })
    })
    return {
      ok: true,
      started: spec.started,
      fallback: spec.started !== kind,
      message: spec.message
    }
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
    this.sessions.get(id)?.pty.write(data)
  }

  /** Whether a live session exists for this terminal id. */
  isAlive(id: string): boolean {
    return this.sessions.has(id)
  }

  resize(id: string, cols: number, rows: number): void {
    this.sessions.get(id)?.pty.resize(clampDimension(cols, 80), clampDimension(rows, 24))
  }

  kill(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    // Delete first: this marks the session superseded, so its (asynchronous,
    // ConPTY-driven) exit event is suppressed rather than misattributed.
    this.sessions.delete(id)
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
  ipcMain.handle('pty:create', (event, args: { id: string } & PtyCreateOptions): PtyCreateResponse => {
    if (
      typeof args?.id !== 'string' ||
      !VALID_ID.test(args.id) ||
      (args.commandKind !== undefined && args.commandKind !== 'shell' && args.commandKind !== 'codex' && args.commandKind !== 'claude')
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
}

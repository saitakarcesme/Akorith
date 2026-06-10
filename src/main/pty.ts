import { ipcMain, type WebContents } from 'electron'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { delimiter, join } from 'path'
import { spawn, type IPty } from 'node-pty'

// Terminal ids are renderer-supplied; accept only short slugs ("t1", "t2", ...).
const VALID_ID = /^[a-z0-9-]{1,32}$/

export interface PtyCreateOptions {
  cols: number
  rows: number
  cwd?: string
}

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

  create(id: string, options: PtyCreateOptions, sink: WebContents): void {
    // Replace any stale session with the same id (e.g. a remounted pane).
    this.kill(id)

    const pty = spawn(resolveDefaultShell(), [], {
      name: 'xterm-color',
      cols: clampDimension(options.cols, 80),
      rows: clampDimension(options.rows, 24),
      cwd: options.cwd ?? homedir(),
      env: process.env as Record<string, string>
      // useConpty is left to node-pty's auto-detection: ConPTY on Win10 1809+,
      // winpty fallback on anything older.
    })

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
  }

  /**
   * The single entry point for sending text/keystrokes into a terminal.
   * Anything that wants to put bytes in front of the shell — a human typing
   * in xterm or a programmatic caller — must go through here.
   *
   * TODO(phase 4): the chat→terminal prompt bridge calls this with the
   *                planner's prompt text.
   * TODO(phase 8): the autonomous loop calls this to drive the CLIs.
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
  ipcMain.handle('pty:create', (event, args: { id: string } & PtyCreateOptions) => {
    if (typeof args?.id !== 'string' || !VALID_ID.test(args.id)) return
    ptyManager.create(args.id, args, event.sender)
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

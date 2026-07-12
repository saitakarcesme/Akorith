'use strict'

const { app } = require('electron')
const { mkdirSync } = require('node:fs')
const { join, resolve } = require('node:path')

const smokeRoot = process.env.AKORITH_SMOKE_USER_DATA
if (!smokeRoot) throw new Error('AKORITH_SMOKE_USER_DATA is required')

mkdirSync(smokeRoot, { recursive: true })
mkdirSync(join(smokeRoot, 'session'), { recursive: true })
app.setPath('userData', smokeRoot)
app.setPath('sessionData', join(smokeRoot, 'session'))

globalThis.__AKORITH_NATIVE_SMOKE__ = { status: 'pending' }

function smokeDatabase() {
  const Database = require('better-sqlite3')
  const file = join(app.getPath('userData'), 'native-smoke.db')
  const database = new Database(file)
  try {
    database.exec('CREATE TABLE smoke (value TEXT NOT NULL)')
    database.prepare('INSERT INTO smoke (value) VALUES (?)').run('sqlite-ok')
    const row = database.prepare('SELECT value FROM smoke LIMIT 1').get()
    if (!row || row.value !== 'sqlite-ok') throw new Error('better-sqlite3 round trip failed')
    return { ok: true, file: resolve(file), value: row.value }
  } finally {
    database.close()
  }
}

function smokePty() {
  const pty = require('node-pty')
  const marker = 'AKORITH_PTY_SMOKE'
  const command = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/sh'
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', `echo ${marker}`] : ['-lc', `printf ${marker}`]

  return new Promise((resolvePromise, reject) => {
    const terminal = pty.spawn(command, args, {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd: app.getPath('userData'),
      env: { ...process.env, TERM: 'xterm-color' }
    })
    let output = ''
    let settled = false
    let timer
    const finish = (error, result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      dataDisposable.dispose()
      exitDisposable.dispose()
      if (error) reject(error)
      else resolvePromise(result)
    }
    const dataDisposable = terminal.onData((data) => {
      output = `${output}${data}`.slice(-8_000)
    })
    const exitDisposable = terminal.onExit(({ exitCode }) => {
      if (exitCode !== 0) {
        finish(new Error(`node-pty child exited ${exitCode}`))
        return
      }
      if (!output.includes(marker)) {
        finish(new Error('node-pty output marker was not observed'))
        return
      }
      finish(null, { ok: true, command, exitCode, markerObserved: true })
    })
    timer = setTimeout(() => {
      try {
        terminal.kill()
      } catch {}
      finish(new Error('node-pty smoke timed out'))
    }, 15_000)
  })
}

app.whenReady().then(async () => {
  try {
    const database = smokeDatabase()
    const pty = await smokePty()
    globalThis.__AKORITH_NATIVE_SMOKE__ = {
      status: 'complete',
      ok: true,
      electronVersion: process.versions.electron,
      modulesAbi: process.versions.modules,
      userData: resolve(app.getPath('userData')),
      database,
      pty
    }
  } catch (error) {
    globalThis.__AKORITH_NATIVE_SMOKE__ = {
      status: 'complete',
      ok: false,
      error: error instanceof Error ? error.stack || error.message : String(error),
      userData: resolve(app.getPath('userData'))
    }
  }
})

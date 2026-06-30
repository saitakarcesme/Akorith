#!/usr/bin/env node
/*
 * Phase 41: make `npm run dev` show "Akorith" (not "Electron") in the macOS menu
 * bar and Dock.
 *
 * In dev, Electron runs from node_modules' own `Electron.app` bundle, and macOS
 * reads the menu-bar app name + Dock tooltip from that bundle's
 * Contents/Info.plist `CFBundleName` — which ships as "Electron". `app.setName()`
 * cannot change it at runtime. This patches that single dev-only Info.plist's
 * CFBundleName/CFBundleDisplayName to "Akorith".
 *
 * Safe + scoped:
 *  - macOS only; no-op on other platforms.
 *  - Touches ONLY node_modules/electron/dist/Electron.app (the local dev copy,
 *    regenerated on install; this script re-applies via postinstall).
 *  - Never touches the packaged app, system apps, or user data.
 *  - Idempotent; never throws fatally (dev/postinstall must not break).
 *  - CFBundleExecutable is left as "Electron" (the actual binary name) so the
 *    app still launches; only the displayed name changes.
 */
'use strict'

const { execFileSync } = require('child_process')
const { existsSync } = require('fs')
const { join } = require('path')

const APP_NAME = 'Akorith'

function main() {
  if (process.platform !== 'darwin') return // menu-bar name patch only matters on macOS

  const plist = join(
    __dirname,
    '..',
    'node_modules',
    'electron',
    'dist',
    'Electron.app',
    'Contents',
    'Info.plist'
  )
  if (!existsSync(plist)) {
    // node_modules may be a symlink elsewhere, or electron not installed yet.
    return
  }

  const pb = '/usr/libexec/PlistBuddy'
  if (!existsSync(pb)) return

  const setKey = (key, value) => {
    try {
      execFileSync(pb, ['-c', `Set :${key} ${value}`, plist], { stdio: 'ignore' })
    } catch {
      // Key may be absent — try to add it.
      try {
        execFileSync(pb, ['-c', `Add :${key} string ${value}`, plist], { stdio: 'ignore' })
      } catch {
        /* leave as-is; never break dev/postinstall */
      }
    }
  }

  setKey('CFBundleName', APP_NAME)
  setKey('CFBundleDisplayName', APP_NAME)
  // eslint-disable-next-line no-console
  console.log(`[akorith] dev Electron bundle name set to "${APP_NAME}" (menu bar / Dock).`)
}

try {
  main()
} catch {
  /* never fail the install/dev start over a cosmetic name patch */
}

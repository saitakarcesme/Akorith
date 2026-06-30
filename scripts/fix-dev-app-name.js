#!/usr/bin/env node
/*
 * Phase 41: make `npm run dev` show "Akorith" (not "Electron") in the macOS menu
 * bar and Dock.
 *
 * In dev, Electron runs from node_modules' own `Electron.app` bundle. This patches
 * that single dev-only Info.plist's CFBundleName/CFBundleDisplayName to "Akorith"
 * as a best effort.
 *
 * HONEST LIMITATION: on current macOS, `npm run dev` may STILL show "Electron" in
 * the menu bar, because electron-vite launches the Electron binary directly (not
 * via LaunchServices/`open`), so macOS derives the app-menu name from the running
 * executable's process identity — which neither `app.setName()` nor this Info.plist
 * patch overrides, and which LaunchServices caches. The PACKAGED app carries its own
 * bundle (CFBundleName=Akorith) and shows Akorith everywhere — that is the app users
 * run. This patch is kept because it is harmless and helps on some setups.
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
  console.log(`[akorith] patched dev Electron bundle name -> "${APP_NAME}" (best effort; macOS dev menu may still show Electron — the packaged app is Akorith).`)
}

try {
  main()
} catch {
  /* never fail the install/dev start over a cosmetic name patch */
}

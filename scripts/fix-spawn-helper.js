// Make node-pty's macOS `spawn-helper` executable after install.
//
// WHY: node-pty 1.1.0 ships prebuilt binaries in its npm tarball, but the
// `spawn-helper` companion binary (which node-pty exec()s to launch the shell
// on Unix) arrives with mode 0644 — no execute bit. On macOS every PTY spawn
// then dies with "posix_spawnp failed", so BOTH Loopex terminals fail to open.
// This hits every macOS user on a clean install, so the fix must run as part of
// install — not as a manual step. It is a no-op on Windows/Linux.
//
// Safe to run repeatedly (chmod is idempotent), tolerant of node-pty version /
// layout changes (the prebuild path is located defensively), and it never fails
// the install: if no spawn-helper is found it warns and exits 0.

const fs = require('fs')
const path = require('path')

function main() {
  if (process.platform !== 'darwin') return // ConPTY/winpty on Win, no helper needed on Linux prebuilds we ship

  let ptyDir
  try {
    ptyDir = path.dirname(require.resolve('node-pty/package.json'))
  } catch {
    console.warn('[fix-spawn-helper] node-pty not installed — nothing to fix')
    return
  }

  // Collect every plausible spawn-helper location: each darwin-* prebuild dir
  // plus a compiled build/ fallback. Globbing the prebuilds dir keeps this
  // working if node-pty renames arches (darwin-arm64, darwin-x64, …).
  const candidates = []
  const prebuilds = path.join(ptyDir, 'prebuilds')
  if (fs.existsSync(prebuilds)) {
    for (const entry of fs.readdirSync(prebuilds)) {
      if (entry.startsWith('darwin')) candidates.push(path.join(prebuilds, entry, 'spawn-helper'))
    }
  }
  candidates.push(path.join(ptyDir, 'build', 'Release', 'spawn-helper'))

  let fixed = 0
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue
    try {
      fs.chmodSync(file, 0o755)
      fixed++
      console.log(`[fix-spawn-helper] chmod +x ${file}`)
    } catch (err) {
      console.warn(`[fix-spawn-helper] could not chmod ${file}:`, err && err.message ? err.message : err)
    }
  }

  if (fixed === 0) {
    console.warn(`[fix-spawn-helper] no spawn-helper found under ${ptyDir} — node-pty layout may have changed`)
  }
}

main()

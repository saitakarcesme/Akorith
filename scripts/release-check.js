#!/usr/bin/env node
/*
 * Phase 41: release preflight. Read-only sanity checks before packaging/release.
 * Never publishes anything, never touches git, never prints secrets.
 */
'use strict'

const { existsSync, readFileSync } = require('fs')
const { join } = require('path')
const { execSync } = require('child_process')

const root = join(__dirname, '..')
const pkg = require(join(root, 'package.json'))
const build = pkg.build ?? {}
const win = build.win ?? {}
const nsis = build.nsis ?? {}

let warnings = 0
let errors = 0
const ok = (m) => console.log(`  \x1b[32mok\x1b[0m   ${m}`)
const warn = (m) => {
  warnings++
  console.log(`  \x1b[33mwarn\x1b[0m ${m}`)
}
const bad = (m) => {
  errors++
  console.log(`  \x1b[31mfail\x1b[0m ${m}`)
}
const hasAkorith = (value) => typeof value === 'string' && value.includes('Akorith')
const isProductNameBased = (value) => typeof value === 'string' && (value.includes('Akorith') || value.includes('${productName}'))

function iconPathExists(iconPath) {
  return typeof iconPath === 'string' && existsSync(join(root, iconPath))
}

function readIcoSizes(relativePath) {
  const buf = readFileSync(join(root, relativePath))
  if (buf.length < 6) throw new Error('ICO header too short')
  const reserved = buf.readUInt16LE(0)
  const type = buf.readUInt16LE(2)
  const count = buf.readUInt16LE(4)
  if (reserved !== 0 || type !== 1) throw new Error(`invalid ICO header reserved=${reserved} type=${type}`)
  if (buf.length < 6 + count * 16) throw new Error('ICO directory truncated')

  const sizes = []
  for (let i = 0; i < count; i++) {
    const offset = 6 + i * 16
    const width = buf[offset] === 0 ? 256 : buf[offset]
    const height = buf[offset + 1] === 0 ? 256 : buf[offset + 1]
    const bits = buf.readUInt16LE(offset + 6)
    sizes.push({ width, height, bits })
  }
  return sizes
}

console.log('== Akorith release check ==')
console.log(`version: ${pkg.version}`)

// 1. Identity
pkg.productName === 'Akorith' ? ok('productName is Akorith') : bad(`productName is "${pkg.productName}"`)
build.appId === 'com.akorith.app' ? ok('appId is com.akorith.app') : bad(`build.appId is "${build.appId}"`)

// 2. Icons
for (const icon of ['build/icon.icns', 'build/icon.ico', 'build/icon.png']) {
  existsSync(join(root, icon)) ? ok(`${icon} present`) : bad(`${icon} missing`)
}
try {
  const expectedSizes = [16, 24, 32, 48, 64, 128, 256]
  const sizes = readIcoSizes('build/icon.ico')
  const present = new Set(sizes.filter((s) => s.width === s.height).map((s) => s.width))
  const missing = expectedSizes.filter((size) => !present.has(size))
  missing.length === 0
    ? ok(`build/icon.ico has Windows sizes ${expectedSizes.join(', ')}`)
    : bad(`build/icon.ico missing Windows sizes: ${missing.join(', ')}`)
  sizes.every((s) => s.bits >= 24)
    ? ok('build/icon.ico entries are true-color/alpha friendly')
    : warn('some build/icon.ico entries are below 24-bit color')
} catch (err) {
  bad(`build/icon.ico is not a readable Windows ICO: ${err.message}`)
}

// 3. Targets
const macT = JSON.stringify(build.mac?.target ?? [])
macT.includes('dmg') ? ok('mac dmg target configured') : warn('mac dmg target not configured')
const winT = JSON.stringify(win.target ?? [])
winT.includes('nsis') ? ok('win nsis target configured') : warn('win nsis target not configured')
winT.includes('portable') ? ok('win portable target configured') : warn('win portable target not configured')

// 4. Windows identity/resource config
win.icon === 'build/icon.ico' && iconPathExists(win.icon)
  ? ok('win.icon points to build/icon.ico')
  : bad(`win.icon should be build/icon.ico, got "${win.icon}"`)
win.executableName === 'Akorith' ? ok('win.executableName is Akorith') : bad(`win.executableName is "${win.executableName}"`)
win.signAndEditExecutable !== false
  ? ok('win.signAndEditExecutable is enabled')
  : bad('win.signAndEditExecutable is disabled; Windows exe resources would stay Electron/default')
isProductNameBased(win.artifactName) && win.artifactName.includes('${version}') && win.artifactName.includes('win')
  ? ok('win.artifactName is Akorith/version/windows based')
  : bad(`win.artifactName is not Akorith/version/windows based: "${win.artifactName}"`)

nsis.shortcutName === 'Akorith' ? ok('nsis.shortcutName is Akorith') : bad(`nsis.shortcutName is "${nsis.shortcutName}"`)
hasAkorith(nsis.uninstallDisplayName)
  ? ok('nsis.uninstallDisplayName is Akorith based')
  : bad(`nsis.uninstallDisplayName is not Akorith based: "${nsis.uninstallDisplayName}"`)
nsis.createDesktopShortcut === true ? ok('nsis creates a desktop shortcut') : bad('nsis.createDesktopShortcut should be true')
nsis.createStartMenuShortcut === true ? ok('nsis creates a Start Menu shortcut') : bad('nsis.createStartMenuShortcut should be true')
for (const key of ['installerIcon', 'uninstallerIcon', 'installerHeaderIcon']) {
  nsis[key] === 'build/icon.ico' && iconPathExists(nsis[key])
    ? ok(`nsis.${key} points to build/icon.ico`)
    : bad(`nsis.${key} should be build/icon.ico, got "${nsis[key]}"`)
}
isProductNameBased(nsis.artifactName) && nsis.artifactName.includes('${version}')
  ? ok('nsis.artifactName is Akorith/version based')
  : bad(`nsis.artifactName is not Akorith/version based: "${nsis.artifactName}"`)

// 5. Release scripts present
for (const s of ['dist:mac', 'dist:win', 'refresh:mac', 'refresh:win']) {
  pkg.scripts?.[s] ? ok(`script "${s}" present`) : warn(`script "${s}" missing`)
}

// 6. CI workflow (shipped as a template; activate by copying into .github/workflows/)
const releaseWorkflowPath = join(root, '.github/workflows/release.yml')
if (existsSync(releaseWorkflowPath)) {
  ok('release workflow active (.github/workflows/release.yml)')
  const releaseWorkflow = readFileSync(releaseWorkflowPath, 'utf8')
  releaseWorkflow.includes('--publish never') && !releaseWorkflow.includes('--publish always')
    ? ok('release packaging is publication-disabled until verification completes')
    : bad('release packaging must use --publish never and must not use --publish always')
  for (const gate of ['verify-release-ref.mjs --require-git', 'Get-AuthenticodeSignature', 'stapler validate', 'verify-release-artifacts.mjs --verify-manifest']) {
    releaseWorkflow.includes(gate) ? ok(`release workflow gate present: ${gate}`) : bad(`release workflow gate missing: ${gate}`)
  }
} else if (existsSync(join(root, 'ci/release.yml'))) {
  ok('release workflow template present (ci/release.yml — copy to .github/workflows/release.yml to activate)')
} else {
  warn('no release workflow (ci/release.yml) found')
}

// 7. Git state (informational)
try {
  const dirty = execSync('git status --porcelain', { cwd: root }).toString().trim()
  dirty ? warn('working tree is dirty (commit before tagging a release)') : ok('working tree clean')
  const tag = `v${pkg.version}`
  const tagged = execSync('git tag --list', { cwd: root }).toString().split('\n').includes(tag)
  tagged ? warn(`tag ${tag} already exists`) : ok(`tag ${tag} is available`)
} catch {
  warn('git status unavailable')
}

// 7. Signing reminder (never fails)
console.log('  note  local builds may be unsigned; the release workflow fails closed unless signing/notarization credentials and artifact verification succeed.')

console.log('')
console.log(`== ${errors} error(s), ${warnings} warning(s) ==`)
if (errors === 0) {
  console.log('Ready to package:  npm run dist:mac   (macOS)   |   CI workflow for Windows')
  console.log('Tag a release:     git tag v' + pkg.version + ' && git push origin v' + pkg.version)
  console.log('Or run the GitHub Actions "release" workflow (workflow_dispatch).')
}
process.exit(errors === 0 ? 0 : 1)

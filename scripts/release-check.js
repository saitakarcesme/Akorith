#!/usr/bin/env node
/*
 * Phase 41: release preflight. Read-only sanity checks before packaging/release.
 * Never publishes anything, never touches git, never prints secrets.
 */
'use strict'

const { existsSync } = require('fs')
const { join } = require('path')
const { execSync } = require('child_process')

const root = join(__dirname, '..')
const pkg = require(join(root, 'package.json'))

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

console.log('== Akorith release check ==')
console.log(`version: ${pkg.version}`)

// 1. Identity
pkg.productName === 'Akorith' ? ok('productName is Akorith') : bad(`productName is "${pkg.productName}"`)
pkg.build?.appId ? ok(`appId ${pkg.build.appId}`) : bad('build.appId missing')

// 2. Icons
for (const icon of ['build/icon.icns', 'build/icon.ico', 'build/icon.png']) {
  existsSync(join(root, icon)) ? ok(`${icon} present`) : bad(`${icon} missing`)
}

// 3. Targets
const macT = JSON.stringify(pkg.build?.mac?.target ?? [])
macT.includes('dmg') ? ok('mac dmg target configured') : warn('mac dmg target not configured')
const winT = JSON.stringify(pkg.build?.win?.target ?? [])
winT.includes('nsis') ? ok('win nsis target configured') : warn('win nsis target not configured')

// 4. Release scripts present
for (const s of ['dist:mac', 'dist:win', 'refresh:mac']) {
  pkg.scripts?.[s] ? ok(`script "${s}" present`) : warn(`script "${s}" missing`)
}

// 5. CI workflow
existsSync(join(root, '.github/workflows/release.yml'))
  ? ok('release workflow present (.github/workflows/release.yml)')
  : warn('no .github/workflows/release.yml')

// 6. Git state (informational)
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
console.log('  note  builds are UNSIGNED unless signing certs/secrets are configured (Gatekeeper/SmartScreen will warn on other machines).')

console.log('')
console.log(`== ${errors} error(s), ${warnings} warning(s) ==`)
if (errors === 0) {
  console.log('Ready to package:  npm run dist:mac   (macOS)   |   CI workflow for Windows')
  console.log('Tag a release:     git tag v' + pkg.version + ' && git push origin v' + pkg.version)
  console.log('Or run the GitHub Actions "release" workflow (workflow_dispatch).')
}
process.exit(errors === 0 ? 0 : 1)

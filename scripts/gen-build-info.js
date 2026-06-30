#!/usr/bin/env node
/*
 * Phase 42 (Remote Ollama): write build-info.json so the packaged app knows which
 * commit it was built from (the app version alone can't tell if the Mac app is
 * behind main). Read at runtime by the main process (app.getBuildInfo).
 *
 * Safe: read-only git queries; never throws fatally; writes one small JSON file.
 */
'use strict'

const { execSync } = require('child_process')
const { writeFileSync } = require('fs')
const { join } = require('path')

const root = join(__dirname, '..')
const pkg = require(join(root, 'package.json'))

function git(args) {
  try {
    return execSync(`git ${args}`, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return ''
  }
}

const info = {
  version: pkg.version || '0.0.0',
  gitCommit: git('rev-parse --short HEAD') || 'unknown',
  gitCommitFull: git('rev-parse HEAD') || 'unknown',
  gitBranch: git('rev-parse --abbrev-ref HEAD') || 'unknown',
  // Build timestamp is passed via env when reproducibility matters; else "now".
  buildDate: process.env.AKORITH_BUILD_DATE || new Date().toISOString(),
  buildMode: process.env.NODE_ENV === 'development' ? 'dev' : 'production'
}

try {
  writeFileSync(join(root, 'build-info.json'), JSON.stringify(info, null, 2) + '\n', 'utf8')
  // eslint-disable-next-line no-console
  console.log(`[akorith] build-info.json -> ${info.version} @ ${info.gitCommit} (${info.gitBranch})`)
} catch {
  /* never fail the build over build metadata */
}

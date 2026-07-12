#!/usr/bin/env node

import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/

function argument(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function fail(message) {
  throw new Error(`release identity rejected: ${message}`)
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

export function validateReleaseIdentity({ tag, root, requireGit = false }) {
  const match = RELEASE_TAG.exec(tag ?? '')
  if (!match) fail('tag must be an exact vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-beta.NUMBER value')

  const version = tag.slice(1)
  const channel = match[4] === undefined ? 'stable' : 'beta'
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  const packageLock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'))
  if (packageJson.version !== version) fail(`package.json version ${packageJson.version ?? '<missing>'} does not equal ${version}`)
  if (packageLock.version !== version || packageLock.packages?.['']?.version !== version) {
    fail('package-lock.json root versions do not exactly match the release tag')
  }
  if (packageJson.build?.generateUpdatesFilesForAllChannels !== true) {
    fail('generateUpdatesFilesForAllChannels must be true for stable/beta feeds')
  }

  if (requireGit) {
    const tagCommit = git(['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], root)
    const head = git(['rev-parse', 'HEAD'], root)
    const main = git(['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'], root)
    if (tagCommit !== head) fail(`checked-out HEAD ${head} is not tagged commit ${tagCommit}`)
    const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', tagCommit, main], { cwd: root, stdio: 'ignore' })
    if (ancestry.status !== 0) fail(`tagged commit ${tagCommit} is not contained in origin/main ${main}`)
    if (git(['status', '--porcelain', '--untracked-files=no'], root)) fail('tracked files are dirty')
  }

  return { tag, version, channel, prerelease: channel === 'beta' }
}

function selfTest() {
  const root = mkdtempSync(resolve(tmpdir(), 'akorith-release-ref-'))
  const fixture = (version) => {
    writeFileSync(resolve(root, 'package.json'), JSON.stringify({ version, build: { generateUpdatesFilesForAllChannels: true } }))
    writeFileSync(resolve(root, 'package-lock.json'), JSON.stringify({ version, packages: { '': { version } } }))
  }
  fixture('1.2.3')
  if (validateReleaseIdentity({ tag: 'v1.2.3', root }).channel !== 'stable') fail('stable self-test failed')
  fixture('2.0.0-beta.4')
  if (validateReleaseIdentity({ tag: 'v2.0.0-beta.4', root }).channel !== 'beta') fail('beta self-test failed')
  for (const tag of ['1.2.3', 'v01.2.3', 'v1.2.3-rc.1', 'v2.0.0-beta']) {
    let rejected = false
    try { validateReleaseIdentity({ tag, root }) } catch { rejected = true }
    if (!rejected) fail(`invalid tag self-test accepted ${tag}`)
  }
  let mismatchRejected = false
  try { validateReleaseIdentity({ tag: 'v2.0.0-beta.5', root }) } catch { mismatchRejected = true }
  if (!mismatchRejected) fail('package/tag mismatch self-test was accepted')
  console.log('verify-release-ref: self-test passed')
}

if (process.argv.includes('--self-test')) {
  selfTest()
} else {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const tag = argument('--tag') ?? process.env.RELEASE_TAG ?? `v${JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version}`
  const identity = validateReleaseIdentity({ tag, root, requireGit: process.argv.includes('--require-git') })
  const outputPath = argument('--github-output') ?? process.env.GITHUB_OUTPUT
  if (outputPath) {
    appendFileSync(outputPath, `tag=${identity.tag}\nversion=${identity.version}\nchannel=${identity.channel}\nprerelease=${identity.prerelease}\n`)
  }
  console.log(JSON.stringify(identity))
}

#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import yaml from 'js-yaml'

const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/

function arg(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function invariant(condition, message) {
  if (!condition) throw new Error(`release artifact rejected: ${message}`)
}

function sha512(path) {
  return createHash('sha512').update(readFileSync(path)).digest('base64')
}

function cleanBasename(value) {
  invariant(typeof value === 'string' && value.length > 0, 'updater payload URL/path is missing')
  return basename(decodeURIComponent(value.split(/[?#]/, 1)[0]))
}

function artifactNames(platform, version, channel) {
  invariant(RELEASE_VERSION.test(version), `invalid version ${version}`)
  invariant(channel === 'stable' || channel === 'beta', `invalid channel ${channel}`)
  invariant((channel === 'beta') === version.includes('-beta.'), `version ${version} does not match ${channel} channel`)
  if (platform === 'windows') {
    const payload = `Akorith-Setup-${version}-x64.exe`
    return {
      payload,
      metadata: channel === 'beta' ? 'beta.yml' : 'latest.yml',
      required: [payload, `Akorith-${version}-portable-x64.exe`, `${payload}.blockmap`]
    }
  }
  invariant(platform === 'macos', `invalid platform ${platform}`)
  const payload = `Akorith-${version}-mac-arm64.zip`
  return {
    payload,
    metadata: channel === 'beta' ? 'beta-mac.yml' : 'latest-mac.yml',
    required: [`Akorith-${version}-mac-arm64.dmg`, payload, `${payload}.blockmap`]
  }
}

function validateUpdaterMetadata(directory, platform, version, channel) {
  const names = artifactNames(platform, version, channel)
  const metadataPath = join(directory, names.metadata)
  invariant(existsSync(metadataPath) && statSync(metadataPath).isFile(), `${names.metadata} is missing`)
  const document = yaml.load(readFileSync(metadataPath, 'utf8'))
  invariant(document && typeof document === 'object' && !Array.isArray(document), `${names.metadata} is not a YAML object`)
  invariant(document.version === version, `${names.metadata} version does not equal ${version}`)
  invariant(Array.isArray(document.files) && document.files.length > 0, `${names.metadata} files are missing`)
  const payloadEntry = document.files.find((item) => item && typeof item === 'object' && cleanBasename(item.url) === names.payload)
  invariant(payloadEntry, `${names.metadata} does not select ${names.payload} as an updater payload`)
  invariant(cleanBasename(document.path) === names.payload, `${names.metadata} path does not equal ${names.payload}`)
  const payloadPath = join(directory, names.payload)
  const payloadSize = statSync(payloadPath).size
  const payloadHash = sha512(payloadPath)
  invariant(payloadEntry.size === payloadSize, `${names.metadata} payload size does not match the signed artifact`)
  invariant(payloadEntry.sha512 === payloadHash, `${names.metadata} payload hash does not match the signed artifact`)
  invariant(document.sha512 === payloadHash, `${names.metadata} top-level hash does not match the signed artifact`)
  invariant(typeof document.releaseDate === 'string' && Number.isFinite(Date.parse(document.releaseDate)), `${names.metadata} releaseDate is invalid`)
  return names
}

function validateRequiredFiles(directory, names) {
  for (const name of [...names.required, names.metadata]) {
    const path = join(directory, name)
    invariant(existsSync(path) && statSync(path).isFile() && statSync(path).size > 0, `${name} is missing or empty`)
  }
}

function manifestEntries(directory, names) {
  return [...names.required, names.metadata].sort().map((file) => ({
    file,
    size: statSync(join(directory, file)).size,
    sha512: sha512(join(directory, file))
  }))
}

function validateManifest(directory, manifest, platform, version, channel, names) {
  invariant(manifest?.schemaVersion === 1, 'manifest schemaVersion must be 1')
  invariant(manifest.platform === platform && manifest.version === version && manifest.channel === channel, 'manifest identity does not match the requested release')
  invariant(Array.isArray(manifest.artifacts), 'manifest artifacts are missing')
  const expected = manifestEntries(directory, names)
  invariant(JSON.stringify(manifest.artifacts) === JSON.stringify(expected), 'manifest inventory, size, or SHA-512 hashes do not match')
}

export function verifyReleaseArtifacts({ platform, version, channel, directory, stageDirectory }) {
  const source = resolve(directory)
  const names = validateUpdaterMetadata(source, platform, version, channel)
  validateRequiredFiles(source, names)

  let target = source
  if (stageDirectory) {
    target = resolve(stageDirectory)
    mkdirSync(target, { recursive: true })
    invariant(readdirSync(target).length === 0, `stage directory ${target} must be empty`)
    for (const name of [...names.required, names.metadata]) copyFileSync(join(source, name), join(target, name))
  }

  const stagedNames = validateUpdaterMetadata(target, platform, version, channel)
  validateRequiredFiles(target, stagedNames)
  const manifest = { schemaVersion: 1, platform, version, channel, artifacts: manifestEntries(target, stagedNames) }
  const manifestName = `release-manifest-${platform}.json`
  writeFileSync(join(target, manifestName), `${JSON.stringify(manifest, null, 2)}\n`)
  validateManifest(target, manifest, platform, version, channel, stagedNames)
  return { directory: target, manifest: manifestName, files: [...manifest.artifacts.map((item) => item.file), manifestName] }
}

export function verifyExistingManifest({ platform, version, channel, directory }) {
  const target = resolve(directory)
  const names = validateUpdaterMetadata(target, platform, version, channel)
  validateRequiredFiles(target, names)
  const manifestName = `release-manifest-${platform}.json`
  const manifest = JSON.parse(readFileSync(join(target, manifestName), 'utf8'))
  validateManifest(target, manifest, platform, version, channel, names)
  return { directory: target, manifest: manifestName, files: [...manifest.artifacts.map((item) => item.file), manifestName] }
}

function selfTest() {
  const root = mkdtempSync(join(tmpdir(), 'akorith-release-artifacts-'))
  for (const { platform, version, channel } of [
    { platform: 'windows', version: '1.2.3', channel: 'stable' },
    { platform: 'macos', version: '1.2.4-beta.2', channel: 'beta' }
  ]) {
    const source = join(root, `${platform}-source`)
    const stage = join(root, `${platform}-stage`)
    mkdirSync(source)
    const names = artifactNames(platform, version, channel)
    for (const name of names.required) writeFileSync(join(source, name), `signed fixture ${name}`)
    const payloadPath = join(source, names.payload)
    const metadata = {
      version,
      files: [{ url: names.payload, sha512: sha512(payloadPath), size: statSync(payloadPath).size }],
      path: names.payload,
      sha512: sha512(payloadPath),
      releaseDate: '2026-01-02T03:04:05.000Z'
    }
    writeFileSync(join(source, names.metadata), yaml.dump(metadata))
    const result = verifyReleaseArtifacts({ platform, version, channel, directory: source, stageDirectory: stage })
    verifyExistingManifest({ platform, version, channel, directory: result.directory })
  }
  console.log('verify-release-artifacts: self-test passed')
}

if (process.argv.includes('--self-test')) {
  selfTest()
} else {
  const options = {
    platform: arg('--platform'),
    version: arg('--version'),
    channel: arg('--channel'),
    directory: arg('--directory') ?? 'dist'
  }
  const result = process.argv.includes('--verify-manifest')
    ? verifyExistingManifest(options)
    : verifyReleaseArtifacts({ ...options, stageDirectory: arg('--stage') })
  console.log(JSON.stringify(result))
}

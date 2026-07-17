import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveStartupRestore } from '../src/main/startupSnapshotCore.ts'

const root = resolve(import.meta.dirname, '..')

function source(path: string): string {
  return readFileSync(resolve(root, path), 'utf8')
}

function matches(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => match[1])
}

const expectedChannels = [
  'research:list',
  'research:get',
  'research:create',
  'research:pause',
  'research:resume',
  'research:archive',
  'research:delete',
  'research:export',
  'research:openArtifact',
  'research:revealArtifact',
  'research:coverDataUrl',
  'research:openSource',
  'research:scheduler'
].sort()

const expectedApiMethods = [
  'list',
  'get',
  'create',
  'pause',
  'resume',
  'archive',
  'remove',
  'export',
  'openArtifact',
  'revealArtifact',
  'coverDataUrl',
  'openSource',
  'scheduler'
].sort()

const ipcSource = source('src/main/research/ipc.ts')
const preloadSource = source('src/preload/index.ts')
const declarationsSource = source('src/preload/index.d.ts')
const mainSource = source('src/main/index.ts')
const sidebarSource = source('src/renderer/src/components/Sidebar.tsx')
const appSource = source('src/renderer/src/App.tsx')
const providerRegistrySource = source('src/main/providers/registry.ts')
const openCodeProviderSource = source('src/main/providers/opencode.ts')
const researchPlannerSource = source('src/main/research/planner.ts')
const researchRunnerSource = source('src/main/research/runner.ts')
const researchSynthesisSource = source('src/main/research/synthesize.ts')

const handledChannels = matches(ipcSource, /ipcMain\.handle\(['"](research:[^'"]+)['"]/g).sort()
const invokedChannels = matches(preloadSource, /ipcRenderer\.invoke\(['"](research:[^'"]+)['"]/g).sort()

assert.deepEqual(handledChannels, expectedChannels, 'main process must register the complete Research IPC surface')
assert.deepEqual(invokedChannels, expectedChannels, 'preload must expose exactly the handled Research channels')

const apiBlock = /export interface ResearchApi \{([\s\S]*?)\n\}/.exec(declarationsSource)?.[1]
assert.ok(apiBlock, 'ResearchApi declaration must exist')
const declaredMethods = matches(apiBlock, /^\s{2}(\w+)\(/gm).sort()
assert.deepEqual(declaredMethods, expectedApiMethods, 'typed preload API must stay aligned with the runtime bridge')

assert.match(declarationsSource, /research:\s*ResearchApi/, 'PreloadApi must include ResearchApi')
assert.match(preloadSource, /const api = Object\.freeze\(\{[^\n]*\bresearch\b[^\n]*\}\)/, 'Research bridge must be included in the exposed API')
assert.match(preloadSource, /contextBridge\.exposeInMainWorld\('api', api\)/, 'preload API must be exposed through contextBridge')

for (const identityMethod of ['openArtifact', 'revealArtifact', 'coverDataUrl', 'openSource']) {
  assert.match(
    apiBlock,
    new RegExp(`${identityMethod}\\(id: string\\)`),
    `${identityMethod} must accept a managed identity rather than a renderer filesystem path`
  )
}

assert.match(ipcSource, /requireId\(input, 'research artifact'\)/, 'artifact actions must validate managed artifact IDs')
assert.match(ipcSource, /requireId\(input, 'research source'\)/, 'source actions must validate managed source IDs')
assert.match(ipcSource, /requirePublicWebUrl\(source\.url\)/, 'source opening must retain the public web URL boundary')

const startup = resolveStartupRestore(
  [{ id: 'project-one' }],
  [{ id: 'chat-one', projectId: 'project-one' }],
  { lastView: 'research', lastActiveProjectId: 'project-one', lastActiveSessionId: 'chat-one' }
)
assert.deepEqual(
  startup,
  { view: 'research', projectId: null, sessionId: null, reason: 'last-view' },
  'Research must restore as a first-class feature destination before stale chat state'
)

assert.match(sidebarSource, /view:\s*'research',[\s\S]*?label:\s*'Research',[\s\S]*?ResearchIcon/, 'sidebar must expose Research')
assert.match(appSource, /view === 'research'[\s\S]*?<ResearchPage active=\{view === 'research'\}/, 'app must mount the Research surface')

assert.match(mainSource, /registerResearchIpc\(\)/, 'main process must register Research IPC at startup')
assert.match(mainSource, /await ensureDbReady\(\)[\s\S]*?startResearchScheduler\(\)/, 'scheduler must start only after persistence is ready')
assert.match(mainSource, /before-quit[\s\S]*?shutdownResearchScheduler\(\)/, 'app shutdown must drain active Research work')
assert.ok(
  mainSource.indexOf('shutdownResearchScheduler()') < mainSource.lastIndexOf('closeDb()'),
  'Research scheduler shutdown must be wired before SQLite close'
)

assert.match(
  providerRegistrySource,
  /workingDirectory:\s*options\.workingDirectory,[\s\S]*?intent:\s*options\.workingDirectory\s*\?\s*'plan'/,
  'managed meta prompts must bind CLI providers to a read-only working directory'
)
for (const [phase, phaseSource] of [
  ['planning', researchPlannerSource],
  ['research', researchRunnerSource],
  ['synthesis', researchSynthesisSource]
] as const) {
  assert.match(
    phaseSource,
    /workingDirectory:\s*job\.workspaceDir/,
    `${phase} prompts must stay inside the managed Research workspace`
  )
}
assert.match(
  openCodeProviderSource,
  /trusted read-only boundary[\s\S]*?Do not create, edit, rename, or delete files/,
  'OpenCode meta prompts must explicitly retain their read-only tool boundary'
)

console.log(`research contract verifier passed (${expectedChannels.length} IPC channels, ${expectedApiMethods.length} typed methods)`)

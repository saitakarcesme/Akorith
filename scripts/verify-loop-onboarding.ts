import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { LoopOnboardingService, type LoopOnboardingRepository } from '../src/main/autonomous-loop/onboarding.ts'
import { applyAutonomousLoopMigrations } from '../src/main/autonomous-loop/migrations.ts'
import { AutonomousLoopStore } from '../src/main/autonomous-loop/store.ts'
import {
  LOOP_EXECUTOR_MANDATORY_CAPABILITIES,
  buildModelCatalog,
  type CapabilityDeclaration,
  type ModelCapabilityProbeRecord,
  type ModelCatalog
} from '../src/main/model-catalog/index.ts'
import { parseGitHubRepositoryUrl, type RepositoryInspection } from '../src/main/repository/index.ts'

const NOW = 1_700_000_000_000
let assertions = 0

function equal<T>(actual: T, expected: T): void {
  assert.deepEqual(actual, expected)
  assertions += 1
}

const capabilities = Object.fromEntries([
  ...LOOP_EXECUTOR_MANDATORY_CAPABILITIES.map((capability) => [capability, true] as const),
  ['reasoning', true]
]) as CapabilityDeclaration

function catalog(withProbe = true): ModelCatalog {
  const providers = [{
    providerId: 'local',
    providerLabel: 'Ollama',
    source: 'local' as const,
    availability: { status: 'available' as const, checkedAt: NOW },
    capabilities,
    models: [{ name: 'qwen:14b', contextWindowTokens: 131_072, capabilities }]
  }]
  const initial = buildModelCatalog({ providers, generatedAt: NOW })
  if (!withProbe) return initial
  const model = initial.models[0]
  const probe: ModelCapabilityProbeRecord = {
    schemaVersion: 1,
    id: 'probe-onboarding',
    catalogModelId: model.id,
    probeKind: 'code_execution',
    probeVersion: 'onboarding-fixture-1',
    status: 'succeeded',
    startedAt: NOW - 2_000,
    completedAt: NOW - 1_000,
    freshUntil: NOW + 86_400_000,
    providerId: model.providerId,
    modelName: model.modelName,
    source: model.source,
    nodeId: model.nodeId,
    capabilities: Object.fromEntries(LOOP_EXECUTOR_MANDATORY_CAPABILITIES.map((capability) => [
      capability,
      { outcome: 'confirmed' as const, summary: `${capability} observed in isolated fixture` }
    ])),
    durationMs: 1_000
  }
  return buildModelCatalog({ providers, probes: [probe], generatedAt: NOW })
}

function inspection(path: string): RepositoryInspection {
  return {
    path,
    gitDirectory: `${path}/.git`,
    branch: 'main',
    headSha: 'a'.repeat(40),
    defaultBranch: 'main',
    dirty: false,
    conflicts: [],
    remotes: {},
    technology: {
      languages: ['TypeScript'],
      packageManagers: ['npm'],
      manifests: ['package.json'],
      scripts: { test: 'vitest run' },
      commands: {
        test: [{ kind: 'test', label: 'npm test', executable: 'npm', args: ['test'], source: 'package.json' }],
        build: [], lint: [], typecheck: []
      },
      scannedFiles: 2,
      truncated: false
    }
  }
}

interface Calls {
  created: number
  cloned: number
  remotes: number
  pushes: number
}

function repository(calls: Calls): LoopOnboardingRepository {
  return {
    async cloneGitHub(url) {
      calls.cloned += 1
      const remote = parseGitHubRepositoryUrl(url)
      return { path: `C:/managed/${remote.repository}`, remote, inspection: inspection(`C:/managed/${remote.repository}`) }
    },
    async createProjectInParent(parent, input) {
      calls.created += 1
      const path = `${parent}/${input.name.toLowerCase().replace(/\s+/g, '-')}`
      return { path, initialCommitSha: 'a'.repeat(40), inspection: inspection(path) }
    },
    async createGitHubRepository(request) {
      return {
        owner: request.owner,
        name: request.name,
        httpsUrl: `https://github.com/${request.owner}/${request.name}`,
        defaultBranch: 'main'
      }
    },
    async addRemote() { calls.remotes += 1; return 'origin' },
    async inspectRemote() {
      return {
        remoteName: 'origin', configured: true, url: 'https://github.com/example/project.git',
        reachable: true, repositoryExists: true, authState: 'authenticated', canPush: true,
        defaultBranch: 'main', errorCode: null, message: 'Push access verified.'
      }
    },
    async push(_path, options) {
      calls.pushes += 1
      return { pushed: true, remoteName: options?.remoteName ?? 'origin', branch: options?.branch ?? 'main', output: 'ok' }
    }
  }
}

function setup(withProbe = true) {
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  applyAutonomousLoopMigrations(database)
  const store = new AutonomousLoopStore(database)
  const calls: Calls = { created: 0, cloned: 0, remotes: 0, pushes: 0 }
  const liveCatalog = catalog(withProbe)
  const service = new LoopOnboardingService({
    store,
    repository: repository(calls),
    catalog: { discover: async () => ({ catalog: liveCatalog, warnings: [] }) },
    identityPlanner: {
      async plan() {
        return {
          value: { summary: 'A quiet notes application.', plan: '1. Add note storage.\n2. Add tests.' },
          usage: { input: 10, output: 8, cached: 0, costUsd: 0 },
          estimated: false,
          durationMs: 5,
          rawSummary: 'Fixture identity.'
        }
      }
    },
    now: () => NOW,
    createId: () => `loop-${store.listLoops().length + 1}`
  })
  const model = liveCatalog.models[0]
  const executor = {
    catalogId: model.id,
    providerId: model.providerId,
    model: model.modelName,
    location: model.source,
    capabilityProbeId: 'probe-onboarding'
  }
  return { database, store, calls, service, executor }
}

async function main(): Promise<void> {
  {
    const value = setup()
    const result = await value.service.create({
      source: {
        kind: 'new', parentPath: 'C:/Projects', projectName: 'Quiet Notes',
        remoteUrl: 'https://github.com/example/quiet-notes.git'
      },
      executor: value.executor
    })
    equal(value.calls.created, 1)
    equal(value.calls.remotes, 1)
    equal(value.calls.pushes, 1)
    equal(result.loop.workspacePath, 'C:/Projects/quiet-notes')
    equal(result.loop.commitCount, 1)
    equal(result.loop.pushCount, 1)
    equal(result.loop.status, 'running')
    equal(result.initialIdentity?.summary, 'A quiet notes application.')
    equal(value.store.listEvents(result.loop.id)[0]?.kind, 'loop-created')
    value.database.close()
  }

  {
    const value = setup()
    const input = {
      source: { kind: 'existing_github', remoteUrl: 'https://github.com/example/existing.git' },
      executor: value.executor
    }
    const result = await value.service.create(input)
    equal(value.calls.cloned, 1)
    equal(result.loop.commitCount, 0)
    equal(result.loop.pushCount, 0)
    await assert.rejects(value.service.create(input), /already has an active Loop/)
    assertions += 1
    equal(value.calls.cloned, 1)
    value.database.close()
  }

  {
    const value = setup(false)
    await assert.rejects(value.service.create({
      source: { kind: 'existing_github', remoteUrl: 'https://github.com/example/unprobed.git' },
      executor: { ...value.executor, capabilityProbeId: 'missing-probe' }
    }), /capability probe/)
    assertions += 1
    equal(value.calls.cloned, 0)
    value.database.close()
  }

  console.log(`verify-loop-onboarding: ${assertions} assertions passed`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

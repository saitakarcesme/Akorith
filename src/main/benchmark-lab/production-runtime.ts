import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { arch, cpus, platform, totalmem } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { app } from 'electron'
import { createAutonomousExecutorRouter } from '../autonomous-loop/executor'
import { RemoteStructuredExecutorClient } from '../autonomous-loop/remote-executor-client'
import type { LoopExecutorSelection, LoopPlannedTask } from '../autonomous-loop/types'
import { getDb } from '../db'
import { getGpuMonitorSnapshot } from '../gpu-monitor'
import { ModelCatalogService, ModelCatalogStore, providerRegistrySource, remoteNodeSource } from '../model-catalog'
import { describeProviders, sendMetaPrompt } from '../providers/registry'
import { runCli, type RunCliResult } from '../providers/util'
import { getRemoteNodeClientManager, REMOTE_NODE_SAFETY_POLICY, type RemoteGenerationEvent, type RemoteNodeCatalog } from '../remote-node'
import { BenchmarkLabService } from './service'
import type { BenchmarkResolvedRuntime, BenchmarkRuntimeResolver } from './service-types'
import { BenchmarkStore } from './store'
import type { BenchmarkHardwareMetadata, BenchmarkValidationEvidence, BenchmarkWorkspace } from './types'

const MAX_FILES = 512
const MAX_FILE_BYTES = 512_000

interface FileSnapshot { path: string; digest: string }

function sha(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

async function snapshot(root: string): Promise<FileSnapshot[]> {
  const files: FileSnapshot[] = []
  async function visit(directory: string): Promise<void> {
    if (files.length >= MAX_FILES) return
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) {
        const info = await stat(path)
        if (info.size > MAX_FILE_BYTES) continue
        const key = relative(root, path).replace(/\\/g, '/')
        files.push({ path: key, digest: sha(await readFile(path)) })
      }
    }
  }
  await visit(root)
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

function changedFiles(before: readonly FileSnapshot[], after: readonly FileSnapshot[]): string[] {
  const prior = new Map(before.map((file) => [file.path, file.digest]))
  const next = new Map(after.map((file) => [file.path, file.digest]))
  return [...new Set([...prior.keys(), ...next.keys()])].filter((path) => prior.get(path) !== next.get(path)).sort()
}

function benchmarkTask(fixture: import('./types').BenchmarkFixture): LoopPlannedTask {
  return {
    title: fixture.title,
    proposedTask: fixture.taskPrompt,
    reason: fixture.summary,
    expectedUserValue: 'Produce independently verifiable benchmark evidence.',
    likelyAreas: fixture.workspaceFiles.map((file) => file.path),
    acceptanceCriteria: fixture.validation.map((item) => item.label),
    validationCommands: [],
    riskLevel: 'low',
    estimatedComplexity: fixture.workspaceFiles.length > 10 ? 'large' : fixture.workspaceFiles.length > 3 ? 'medium' : 'small',
    kind: fixture.category === 'debugging_repair' || fixture.category === 'repository_repair' ? 'bug_fix' : 'code'
  }
}

function selection(model: Parameters<BenchmarkRuntimeResolver['resolve']>[0]): LoopExecutorSelection {
  return {
    catalogId: model.id,
    providerId: model.providerId,
    model: model.modelName,
    location: model.source,
    ...(model.nodeId ? { nodeId: model.nodeId } : {}),
    capabilityProbeId: model.latestProbe?.id ?? `benchmark:${model.id}`
  }
}

interface TestCommandResult extends RunCliResult { commandLabel: string; durationMs: number; timedOut: boolean }

async function fileExists(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile() } catch { return false }
}

async function runEvidenceCommand(
  workspace: BenchmarkWorkspace,
  executable: string,
  args: string[],
  commandLabel: string,
  signal: AbortSignal,
  timeoutMs = 60_000
): Promise<TestCommandResult> {
  const startedAt = performance.now()
  try {
    const result = await runCli(executable, args, { cwd: workspace.rootPath!, signal, timeoutMs, maxOutputChars: 200_000 })
    return { ...result, commandLabel, durationMs: Math.max(0, performance.now() - startedAt), timedOut: false }
  } catch (error) {
    if (signal.aborted) throw error
    const message = error instanceof Error ? error.message : String(error)
    return {
      code: null, stdout: '', stderr: message.slice(0, 4_000), commandLabel,
      durationMs: Math.max(0, performance.now() - startedAt), timedOut: /timed out/i.test(message)
    }
  }
}

async function safeTestCommand(workspace: BenchmarkWorkspace, signal: AbortSignal): Promise<TestCommandResult | null> {
  if (!workspace.rootPath) return null
  try {
    const parsed = JSON.parse(await readFile(join(workspace.rootPath, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> }
    if (typeof parsed.scripts?.test === 'string') {
      return runEvidenceCommand(workspace, 'npm', ['test', '--silent'], 'declared npm test', signal)
    }
  } catch {
    // Continue through fixed language harness detection.
  }
  if (await fileExists(join(workspace.rootPath, 'go.mod'))) {
    return runEvidenceCommand(workspace, 'go', ['test', './...'], 'go test ./...', signal)
  }
  if (await fileExists(join(workspace.rootPath, 'Cargo.toml'))) {
    return runEvidenceCommand(workspace, 'cargo', ['test', '--quiet'], 'cargo test --quiet', signal)
  }
  if (await fileExists(join(workspace.rootPath, 'tests', 'test_cache.py'))) {
    return runEvidenceCommand(workspace, process.platform === 'win32' ? 'python' : 'python3', ['-m', 'unittest', 'discover', '-s', 'tests'], 'python unittest', signal)
  }
  if (await fileExists(join(workspace.rootPath, 'tests', 'cache_test.cpp'))) {
    const binary = join(workspace.rootPath, `.akorith-cache-test${process.platform === 'win32' ? '.exe' : ''}`)
    const compile = await runEvidenceCommand(workspace, 'g++', ['-std=c++20', 'tests/cache_test.cpp', '-o', binary], 'C++ compile', signal)
    if (compile.code !== 0) return compile
    const run = await runEvidenceCommand(workspace, binary, [], 'C++ assertion harness', signal)
    return { ...run, durationMs: compile.durationMs + run.durationMs, stdout: `${compile.stdout}${run.stdout}`, stderr: `${compile.stderr}${run.stderr}` }
  }
  if (await fileExists(join(workspace.rootPath, 'tests', 'CacheTest.java'))) {
    const output = join(workspace.rootPath, '.akorith-java')
    const compile = await runEvidenceCommand(workspace, 'javac', ['-d', output, 'src/Cache.java', 'tests/CacheTest.java'], 'Java compile', signal)
    if (compile.code !== 0) return compile
    const run = await runEvidenceCommand(workspace, 'java', ['-cp', output, 'CacheTest'], 'Java assertion harness', signal)
    return { ...run, durationMs: compile.durationMs + run.durationMs, stdout: `${compile.stdout}${run.stdout}`, stderr: `${compile.stderr}${run.stderr}` }
  }
  return null
}

function processEvidence(result: TestCommandResult | null): import('./types').BenchmarkProcessEvidence | null {
  if (!result) return null
  return {
    commandLabel: result.commandLabel,
    exitCode: result.code,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    stdoutDigest: result.stdout ? sha(result.stdout) : null,
    stderrDigest: result.stderr ? sha(result.stderr) : null
  }
}

function runtimeFor(model: Parameters<BenchmarkRuntimeResolver['resolve']>[0]): BenchmarkResolvedRuntime {
  const router = createAutonomousExecutorRouter(new RemoteStructuredExecutorClient(getRemoteNodeClientManager()))
  return {
    planner: {
      id: `akorith-model-planner:${model.providerId}`,
      async plan({ fixture, signal }) {
        const prompt = `You are the planning phase of a reproducible coding benchmark. Produce a concise implementation plan for the selected executor. Do not reveal private chain-of-thought. Do not change or weaken tests.\n\nFixture: ${fixture.id}\nTask: ${fixture.taskPrompt}\nFiles:\n${fixture.workspaceFiles.map((file) => `- ${file.path}`).join('\n')}\nValidation:\n${fixture.validation.map((item) => `- ${item.label}`).join('\n')}`
        if (model.source === 'remote') {
          if (!model.nodeId) throw new Error('Remote benchmark planner is missing its node identity.')
          const plan = await remoteProbeText(model.nodeId, model.modelName, prompt, signal, () => undefined)
          return {
            plan: plan.slice(0, 20_000),
            summary: `Plan generated by ${model.displayLabel}.`,
            usage: { source: 'unavailable', inputTokens: null, outputTokens: null, cachedTokens: null, costUsd: null }
          }
        }
        const result = await sendMetaPrompt(model.providerId, model.modelName, prompt, signal)
        return {
          plan: result.text.slice(0, 20_000),
          summary: `Plan generated by ${model.displayLabel}.`,
          usage: {
            source: result.usage.estimated ? 'estimated' : 'reported',
            inputTokens: result.usage.promptTokens ?? null,
            outputTokens: result.usage.completionTokens ?? null,
            cachedTokens: null,
            costUsd: result.usage.estimated ? null : result.usage.costUsd ?? null
          }
        }
      }
    },
    executor: {
      id: `akorith-production-executor:${model.providerId}`,
      async execute({ fixture, workspace, plan, signal }) {
        if (!workspace.rootPath) throw new Error('Production benchmark workspace is unavailable.')
        const before = await snapshot(workspace.rootPath)
        const result = await router.execute({
          workspacePath: workspace.rootPath,
          selection: selection(model),
          task: benchmarkTask(fixture),
          repositoryContext: JSON.stringify({ fixture: fixture.id, files: fixture.workspaceFiles.map((file) => file.path), modelPlan: plan.plan }),
          timeoutMs: fixture.timeoutMs,
          signal
        })
        const after = await snapshot(workspace.rootPath)
        const artifacts = changedFiles(before, after)
        return {
          status: result.outcome === 'completed' ? 'completed' : 'failed',
          summary: result.summary,
          artifactReferences: artifacts,
          usage: {
            source: result.estimatedUsage ? 'estimated' : 'reported',
            inputTokens: result.usage.input,
            outputTokens: result.usage.output,
            cachedTokens: result.usage.cached,
            costUsd: result.estimatedUsage ? null : result.usage.costUsd
          },
          error: result.outcome === 'completed' ? null : result.summary
        }
      }
    },
    validator: {
      id: 'akorith-independent-workspace-validator',
      version: '1.0.0',
      async validate({ fixture, workspace, execution, signal }): Promise<BenchmarkValidationEvidence> {
        if (!workspace.rootPath) throw new Error('Production benchmark workspace is unavailable.')
        const files = await snapshot(workspace.rootPath)
        const fileMap = new Map(files.map((file) => [file.path, file.digest]))
        const originalPresent = fixture.workspaceFiles.every((file) => fileMap.has(file.path))
        const process = await safeTestCommand(workspace, signal)
        const processView = processEvidence(process)
        const changed = execution.artifactReferences.filter((path) => fileMap.has(path))
        const focused = execution.artifactReferences.length <= 64 && execution.artifactReferences.every((path) => {
          const absolute = resolve(workspace.rootPath!, path)
          const relativePath = relative(workspace.rootPath!, absolute)
          return relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !relativePath.startsWith('.git')
        })
        const observations = fixture.validation.map((requirement) => {
          let passed = false
          let summary = 'No deterministic evidence satisfied this requirement.'
          if (requirement.kind === 'test_command') {
            passed = process?.code === 0 && !process.timedOut
            summary = process ? (passed ? 'The declared test command passed.' : 'The declared test command failed or timed out.') : 'The fixture exposed no runnable declared test command.'
          } else if (requirement.kind === 'artifact_check') {
            passed = changed.length > 0
            summary = passed ? `${changed.length} changed artifact(s) were independently hashed.` : 'No changed artifact was observed.'
          } else if (requirement.kind === 'repository_assertion') {
            passed = originalPresent && focused
            summary = passed ? 'Original fixture files remain and changed paths stay inside the bounded workspace.' : 'The workspace lost fixture files or contains an out-of-scope path.'
          } else if (requirement.kind === 'behavior_assertion') {
            passed = process?.code === 0 && !process.timedOut
            summary = passed ? 'Behavior is supported by a passing declared test process.' : 'Behavior was not claimed without passing process evidence.'
          }
          const artifact = changed[0]
          return {
            requirementId: requirement.id,
            passed,
            observedAt: Date.now(),
            source: requirement.kind === 'test_command' || requirement.kind === 'behavior_assertion' ? 'process' as const : 'filesystem' as const,
            summary,
            process: requirement.kind === 'test_command' || requirement.kind === 'behavior_assertion' ? processView : null,
            filesystem: artifact ? { relativePath: artifact, sha256: fileMap.get(artifact) ?? null } : null
          }
        })
        return {
          schemaVersion: 1,
          validatorId: 'akorith-independent-workspace-validator',
          validatorVersion: '1.0.0',
          fixtureId: fixture.id,
          fixtureRevision: fixture.revision,
          capturedAt: Date.now(),
          simulated: false,
          observations,
          logsDigest: sha(JSON.stringify(observations))
        }
      }
    },
    configuration: {
      harnessVersion: '1.0.0', instructionProfileId: 'akorith-production-benchmark-v1', maxAttempts: 1,
      temperature: { support: 'unknown', requested: null, applied: null }, providerParameters: {},
      unsupportedParameters: ['temperature'], dependencyVersions: { akorith: app.getVersion() }, environmentImage: null
    }
  }
}

async function remoteCatalogs(signal: AbortSignal): Promise<readonly RemoteNodeCatalog[]> {
  const manager = getRemoteNodeClientManager()
  const catalogs: RemoteNodeCatalog[] = []
  for (const node of await manager.list()) {
    if (signal.aborted) throw signal.reason
    try { catalogs.push((await manager.catalog(node.id)).catalog) } catch { /* offline nodes are omitted from available benchmark targets */ }
  }
  return catalogs
}

async function remoteProbeText(nodeId: string, modelName: string, prompt: string, signal: AbortSignal, onDelta: (text: string) => void): Promise<string> {
  const manager = getRemoteNodeClientManager()
  const { catalog } = await manager.catalog(nodeId)
  const model = catalog.models.find((candidate) => candidate.id === modelName || candidate.name === modelName)
  if (!model) throw new Error('Remote model was not found.')
  const handle = await manager.client(nodeId)
  const stream = handle.client.generate({ modelKey: model.key, messages: [{ role: 'user', content: prompt }], maxOutputTokens: 8_192, safety: { ...REMOTE_NODE_SAFETY_POLICY } }, signal)
  let text = ''
  for await (const event of stream as AsyncIterable<RemoteGenerationEvent>) if (event.type === 'delta') { text += event.text; onDelta(event.text) }
  return text
}

function catalogService(): ModelCatalogService {
  return new ModelCatalogService({
    store: new ModelCatalogStore(getDb()),
    providers: providerRegistrySource(describeProviders),
    remoteNodes: remoteNodeSource(remoteCatalogs),
    resolveTransport: (model) => ({
      async complete({ prompt, signal, onDelta }) {
        if (model.source === 'remote') {
          if (!model.nodeId) throw new Error('Remote model node is missing.')
          return remoteProbeText(model.nodeId, model.modelName, prompt, signal, onDelta)
        }
        const result = await sendMetaPrompt(model.providerId, model.modelName, prompt, signal)
        onDelta(result.text)
        return result.text
      }
    }),
    tempRoot: join(app.getPath('temp'), 'akorith-benchmark-probes')
  })
}

async function hardware(model: Parameters<BenchmarkRuntimeResolver['resolve']>[0], signal: AbortSignal): Promise<BenchmarkHardwareMetadata> {
  if (model.source === 'remote' && model.nodeId) {
    const { catalog } = await getRemoteNodeClientManager().catalog(model.nodeId)
    const value = catalog.hardware
    return {
      source: 'reported', platform: value.platform, architecture: value.architecture,
      cpuModel: value.cpu.model ?? null, cpuLogicalCores: value.cpu.logicalCores,
      ramMb: value.memory.totalBytes === undefined ? null : value.memory.totalBytes / (1024 * 1024),
      gpuModel: value.gpu.status === 'observed' ? value.gpu.devices.map((gpu) => gpu.name).join(', ') : null,
      vramMb: value.gpu.status === 'observed' ? value.gpu.devices.reduce((sum, gpu) => sum + (gpu.memoryTotalBytes ?? 0), 0) / (1024 * 1024) : null,
      nodeId: model.nodeId
    }
  }
  if (signal.aborted) throw signal.reason
  if (model.source === 'cloud') return { source: 'unavailable', platform: null, architecture: null, cpuModel: null, cpuLogicalCores: null, ramMb: null, gpuModel: null, vramMb: null, nodeId: null }
  const observed = getGpuMonitorSnapshot().sources.find((source) => source.location === 'local')?.lastObservation
  return {
    source: 'observed', platform: platform(), architecture: arch(), cpuModel: cpus()[0]?.model ?? null,
    cpuLogicalCores: cpus().length, ramMb: totalmem() / (1024 * 1024),
    gpuModel: observed?.status === 'observed' ? observed.devices.map((gpu) => gpu.name).join(', ') : null,
    vramMb: observed?.status === 'observed' ? observed.devices.reduce((sum, gpu) => sum + (gpu.memoryTotalMb ?? 0), 0) : null,
    nodeId: model.nodeId
  }
}

let runtime: BenchmarkLabService | null = null

export function getBenchmarkLabRuntime(): BenchmarkLabService {
  runtime ??= new BenchmarkLabService({
    store: new BenchmarkStore(getDb()), modelCatalog: catalogService(),
    runtimeResolver: { resolve: async (model) => runtimeFor(model) },
    hardware: { observe: hardware }, tempRoot: join(app.getPath('temp'), 'akorith-benchmark-runs')
  })
  return runtime
}

export function stopBenchmarkLabRuntime(): void {
  runtime = null
}

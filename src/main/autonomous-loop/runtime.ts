import { app } from 'electron'
import { join } from 'node:path'
import { getDb } from '../db'
import { ModelCatalogService, ModelCatalogStore, providerRegistrySource, remoteNodeSource, type ProbeTransportResolver } from '../model-catalog'
import { describeProviders, sendMetaPrompt } from '../providers/registry'
import { getRemoteNodeClientManager, REMOTE_NODE_SAFETY_POLICY, type RemoteGenerationEvent, type RemoteNodeCatalog } from '../remote-node'
import { GitHubCliRepositoryAdapter, RepositoryService } from '../repository'
import { AutonomousLoopEngine } from './engine'
import { createAutonomousExecutorRouter } from './executor'
import { LoopOnboardingService } from './onboarding'
import { createProductionLoopDependencies } from './production-dependencies'
import { AutonomousLoopService } from './service'
import { AutonomousLoopStore } from './store'
import { RemoteStructuredExecutorClient } from './remote-executor-client'

let runtime: AutonomousLoopService | null = null

async function remoteText(modelName: string, nodeId: string, prompt: string, signal: AbortSignal, onDelta: (text: string) => void): Promise<string> {
  const manager = getRemoteNodeClientManager()
  const { catalog } = await manager.catalog(nodeId)
  const model = catalog.models.find((candidate) => candidate.id === modelName || candidate.name === modelName || candidate.key === modelName)
  if (!model?.available) throw new Error('Remote probe model is unavailable.')
  const handle = await manager.client(nodeId)
  const stream = handle.client.generate({
    modelKey: model.key,
    messages: [{ role: 'user', content: prompt }],
    maxOutputTokens: 8_192,
    safety: { ...REMOTE_NODE_SAFETY_POLICY }
  }, signal)
  let text = ''
  for await (const event of stream as AsyncIterable<RemoteGenerationEvent>) {
    if (event.type === 'delta') { text += event.text; onDelta(event.text) }
    if (event.type === 'error') throw new Error(event.message)
  }
  return text
}

const providerProbeTransport: ProbeTransportResolver = (model) => ({
  async complete({ prompt, signal, onDelta }) {
    if (model.source === 'remote') {
      if (!model.nodeId) throw new Error('Remote model is missing its node identity.')
      return remoteText(model.modelName, model.nodeId, prompt, signal, onDelta)
    }
    const result = await sendMetaPrompt(model.providerId, model.modelName, prompt, signal)
    onDelta(result.text)
    return result.text
  }
})

async function remoteCatalogs(signal: AbortSignal): Promise<readonly RemoteNodeCatalog[]> {
  const manager = getRemoteNodeClientManager()
  const nodes = await manager.list()
  const catalogs: RemoteNodeCatalog[] = []
  for (const node of nodes) {
    if (signal.aborted) throw signal.reason
    try { catalogs.push((await manager.catalog(node.id)).catalog) } catch { /* offline nodes stay visible through manager health */ }
  }
  return catalogs
}

export function getAutonomousLoopRuntime(): AutonomousLoopService {
  if (runtime) return runtime
  const database = getDb()
  const store = new AutonomousLoopStore(database)
  const repository = new RepositoryService({
    managedRoot: join(app.getPath('userData'), 'loop-workspaces'),
    githubAdapter: new GitHubCliRepositoryAdapter()
  })
  const catalog = new ModelCatalogService({
    store: new ModelCatalogStore(database),
    providers: providerRegistrySource(describeProviders),
    remoteNodes: remoteNodeSource(remoteCatalogs),
    resolveTransport: providerProbeTransport,
    tempRoot: join(app.getPath('temp'), 'akorith-model-probes')
  })
  const executor = createAutonomousExecutorRouter(new RemoteStructuredExecutorClient(getRemoteNodeClientManager()))
  const onboarding = new LoopOnboardingService({ store, repository, catalog })
  const engine = new AutonomousLoopEngine(
    store,
    createProductionLoopDependencies({ repository, executor })
  )
  runtime = new AutonomousLoopService({ store, repository, catalog, onboarding, engine })
  return runtime
}

export async function startAutonomousLoopRuntime(): Promise<void> {
  await getAutonomousLoopRuntime().start()
}

export function stopAutonomousLoopRuntime(): void {
  runtime?.dispose()
  runtime = null
}

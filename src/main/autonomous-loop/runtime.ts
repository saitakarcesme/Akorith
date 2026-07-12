import { app } from 'electron'
import { join } from 'node:path'
import { getDb } from '../db'
import { ModelCatalogService, ModelCatalogStore, providerRegistrySource, type ProbeTransportResolver } from '../model-catalog'
import { describeProviders, sendMetaPrompt } from '../providers/registry'
import { RepositoryService } from '../repository'
import { AutonomousLoopEngine } from './engine'
import { createAutonomousExecutorRouter } from './executor'
import { LoopOnboardingService } from './onboarding'
import { createProductionLoopDependencies } from './production-dependencies'
import { AutonomousLoopService } from './service'
import { AutonomousLoopStore } from './store'

let runtime: AutonomousLoopService | null = null

const providerProbeTransport: ProbeTransportResolver = (model) => ({
  async complete({ prompt, signal, onDelta }) {
    const result = await sendMetaPrompt(model.providerId, model.modelName, prompt, signal)
    onDelta(result.text)
    return result.text
  }
})

export function getAutonomousLoopRuntime(): AutonomousLoopService {
  if (runtime) return runtime
  const database = getDb()
  const store = new AutonomousLoopStore(database)
  const repository = new RepositoryService({
    managedRoot: join(app.getPath('userData'), 'loop-workspaces')
  })
  const catalog = new ModelCatalogService({
    store: new ModelCatalogStore(database),
    providers: providerRegistrySource(describeProviders),
    resolveTransport: providerProbeTransport,
    tempRoot: join(app.getPath('temp'), 'akorith-model-probes')
  })
  const executor = createAutonomousExecutorRouter()
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


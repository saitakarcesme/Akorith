import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { deriveWorkspaceWorkflow } from '../src/renderer/src/workspaceWorkflow'

const root = join(__dirname, '..')
const failures: string[] = []

function read(relativePath: string): string {
  const absolutePath = join(root, relativePath)
  if (!existsSync(absolutePath)) {
    failures.push(`${relativePath} exists`)
    return ''
  }
  return readFileSync(absolutePath, 'utf8')
}

function check(value: unknown, label: string): void {
  if (value) {
    console.log(`[ok] ${label}`)
    return
  }
  failures.push(label)
  console.error(`[fail] ${label}`)
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const app = read('src/renderer/src/App.tsx')
const chat = read('src/renderer/src/components/ChatPanel.tsx')
const dashboard = read('src/renderer/src/components/Dashboard.tsx')
const gpuStatus = read('src/main/gpu-status.ts')
const main = read('src/main/index.ts')
const sidebar = read('src/renderer/src/components/Sidebar.tsx')
const providerRegistry = read('src/main/providers/registry.ts')
const researchService = read('src/main/research/service.ts')
const researchIpc = read('src/main/research/ipc.ts')
const researchSynthesize = read('src/main/research/synthesize.ts')
const workspaceActivity = read('src/renderer/src/components/WorkspaceActivity.tsx')
const workspaceStepDock = read('src/renderer/src/components/WorkspaceStepDock.tsx')
const projectPreview = read('src/renderer/src/components/ProjectPreviewPanel.tsx')
const testPage = read('src/renderer/src/components/TestPage.tsx')
const benchmarkPage = read('src/renderer/src/components/BenchmarkPage.tsx')
const researchPage = read('src/renderer/src/components/ResearchPage.tsx')
const researchLibrary = read('src/renderer/src/components/ResearchLibrary.tsx')
const projectFiles = read('src/main/project-files.ts')
const ollamaConnection = read('src/main/ollama-connection.ts')
const pluginManager = read('src/main/plugins/manager.ts')
const database = read('src/main/db.ts')
const replicaCss = read('src/renderer/src/replica-ui.css')
const productPolishCss = read('src/renderer/src/product-polish.css')

for (const component of ['Dashboard', 'Plugins', 'TestPage', 'ResearchPage']) {
  check(
    new RegExp(`const\\s+${escaped(component)}\\s*=\\s*lazy\\(\\(\\)\\s*=>\\s*import\\(`).test(app),
    `${component} is split out of the startup bundle`
  )
  check(
    !new RegExp(`import\\s+${escaped(component)}\\s+from`).test(app),
    `${component} has no eager renderer import`
  )
}

check(
  app.includes("PERSISTENT_FEATURE_VIEWS = new Set<AppView>(['test', 'research'])") &&
    app.includes("view === 'test' || mountedFeatureViews.has('test')") &&
    app.includes("view === 'research' || mountedFeatureViews.has('research')"),
  'long-running feature pages mount on first visit and then preserve active work'
)
check(
  !app.includes("const ProjectLoopPage = lazy") &&
    !app.includes('loops-page-wrap') &&
    !sidebar.includes("{ view: 'loops'") &&
    !sidebar.includes("import('./ProjectLoopPage')"),
  'standalone Loop route and navigation stay out of the renderer'
)
check(
  sidebar.includes('FEATURE_PRELOADERS') &&
    sidebar.includes('onPointerEnter={() => preloadFeatureView(item.view)}') &&
    sidebar.includes("preloadFeatureView('dashboard')"),
  'feature chunks begin loading on navigation intent before the click'
)
check(
  sidebar.includes("const SettingsCenter = lazy(() => import('./SettingsCenter'))") &&
    sidebar.includes('onPointerEnter={preloadSettingsCenter}') &&
    sidebar.includes('<Suspense fallback='),
  'Settings stays out of the startup bundle and preloads on intent'
)
check(
  chat.includes("const ChatMessageView = lazy(loadChatMessageView)") &&
    chat.includes("const loadChatMessageView = () => import('./ChatMessageView')") &&
    chat.includes('onFocus={() => { void loadChatMessageView() }}'),
  'Markdown parser loads after conversation intent instead of at blank-workspace startup'
)

const tokenInterval = Number(chat.match(/TOKEN_RENDER_INTERVAL_MS\s*=\s*(\d+)/)?.[1])
const tokenListener = chat.slice(chat.indexOf('const offToken'), chat.indexOf('const offActivity'))
check(
  Number.isFinite(tokenInterval) && tokenInterval >= 80 && tokenInterval <= 120,
  'streaming text uses an efficient 80-120 ms render batch'
)
check(
  tokenListener.includes('window.setTimeout') && !tokenListener.includes('requestAnimationFrame'),
  'streaming tokens are batched instead of reparsing Markdown every display frame'
)
const sessionMessageUpdater = chat.slice(chat.indexOf('const setSessionMessages'), chat.indexOf('const loadProviders'))
check(
  sessionMessageUpdater.includes('if (activeRef.current) setMessages(next)') &&
    chat.includes('setMessages((current) => current === latest ? current : latest)'),
  'hidden chat updates canonical refs and publishes one transcript snapshot on return'
)
check(
  chat.includes('historyHydrationRequestRef') &&
    chat.includes('requestNonce !== historyHydrationRequestRef.current'),
  'stale history hydration cannot overwrite a newer chat selection'
)
const resizeComposerStart = chat.indexOf('const resizeComposer')
const composerResize = chat.slice(resizeComposerStart, chat.indexOf('useLayoutEffect', resizeComposerStart))
check(
  (composerResize.match(/input\.scrollHeight/g) ?? []).length === 1,
  'composer auto-grow measures scrollHeight only once per resize'
)
check(
  productPolishCss.includes('.chat-messages { scroll-behavior: auto; }') &&
    !productPolishCss.includes('.chat-messages { scroll-behavior: smooth; }'),
  'streaming auto-follow does not enqueue smooth-scroll animations'
)

const workflowMemo = chat.slice(chat.indexOf('const latestWorkspaceSteps'), chat.indexOf('const busyRequestId'))
check(
  workflowMemo.includes('useMemo') &&
    workflowMemo.includes('latestWorkspaceActivities') &&
    !/\[\s*messages\s*\]/.test(workflowMemo),
  'task workflow derivation is insulated from assistant token updates'
)
check(
  workspaceActivity.includes('export default memo(WorkspaceActivity)') &&
    workspaceStepDock.includes('export default memo(WorkspaceStepDock)'),
  'stable Workspace progress displays skip unrelated chat renders'
)

check(
  gpuStatus.includes('GPU_STATUS_CACHE_MS') &&
    gpuStatus.includes('gpuStatusInFlight') &&
    gpuStatus.includes('if (gpuStatusInFlight) return gpuStatusInFlight'),
  'GPU telemetry coalesces concurrent expensive OS probes'
)
check(
  providerRegistry.includes('PROVIDER_SNAPSHOT_CACHE_MS = 60_000') &&
    providerRegistry.includes('providerSnapshotInFlight') &&
    providerRegistry.includes('JSON.stringify(config.providers)') &&
    providerRegistry.includes('describeProviders(force = false)') &&
    providerRegistry.includes('return describeProviders(force)'),
  'provider discovery uses a config-aware one-minute cache with explicit refresh'
)
check(
  ollamaConnection.includes('AUTO_CONNECT_CACHE_MS') &&
    ollamaConnection.includes('autoConnectInFlight') &&
    ollamaConnection.includes('if (autoConnectInFlight) return autoConnectInFlight'),
  'concurrent Ollama auto-connect requests share one network scan'
)
check(
  projectFiles.includes('FILE_INDEX_TTL_MS') &&
    projectFiles.includes('pendingIndexes') &&
    projectFiles.includes('const files = await getFileIndex(root)'),
  'project file mentions reuse a bounded single-flight file index'
)
check(
  pluginManager.includes('DIAGNOSTIC_CACHE_TTL_MS') &&
    pluginManager.includes('diagnosticsSweepInFlight') &&
    pluginManager.includes('STARTUP_DIAGNOSTIC_DELAY_MS') &&
    pluginManager.includes('checkAllPlugins({ force: true })'),
  'plugin diagnostics are deferred, cached, coalesced, and manually refreshable'
)
check(
  [researchService, researchIpc, researchSynthesize].every((source) =>
    !/import\s+\{\s*exportResearchJob\s*\}\s+from\s+['"]\.\/exporters['"]/.test(source) &&
    source.includes("await import('./exporters')")
  ),
  'heavy Research exporters load only when an artifact is requested'
)
check(
  dashboard.includes("document.addEventListener('visibilitychange'") &&
    dashboard.includes('document.hidden ? 10_000 : 3_000') &&
    !dashboard.includes('sampleCompute(), 1_800'),
  'Dashboard telemetry slows down while hidden and avoids sub-cache polling'
)
check(
  dashboard.includes('const ActivityHeatmaps = memo(') &&
    dashboard.includes('<ActivityHeatmaps'),
  'GPU samples do not rebuild both year-long activity heatmaps'
)
check(
  testPage.includes("export { default } from './BenchmarkPage'") &&
    benchmarkPage.includes('if (!active || !providers.some(isLocalStarting)) return'),
  'hidden Benchmark stops local-provider retry polling'
)
check(
  researchLibrary.includes('LIBRARY_PAGE_SIZE = 48') &&
    researchLibrary.includes('visibleJobs.slice(0, visibleLimit)') &&
    researchPage.includes('pendingCoverIdsRef') &&
    researchPage.includes('onNeedCovers={requestCovers}'),
  'Research Library paginates DOM and loads only visible covers'
)
check(
  app.includes("active={view === 'workspace' || view === 'general'}") &&
    projectPreview.includes('if (!active || !session') &&
    projectPreview.includes('if (document.hidden || pollingRef.current) return'),
  'hidden Workspace previews stop capturePage polling'
)
check(
  replicaCss.includes('.chat-msg:not(.streaming)') &&
    replicaCss.includes('content-visibility: auto') &&
    replicaCss.includes('contain-intrinsic-size: auto 120px'),
  'off-screen completed messages skip layout and paint work'
)
const splashFloor = Number(main.match(/MIN_SPLASH_MS\s*=\s*(\d+)/)?.[1])
check(
  Number.isFinite(splashFloor) && splashFloor > 0 && splashFloor <= 500,
  'startup splash anti-flash floor stays at or below 500 ms'
)
check(
  database.includes('DB_SCHEMA_VERSION') &&
    database.includes("pragma('user_version', { simple: true })") &&
    database.includes('if (currentSchemaVersion >= DB_SCHEMA_VERSION) return'),
  'completed SQLite migrations skip repeated schema probes and backfills'
)
check(
  sidebar.includes('if (startupSnapshot && historyVersion === 0) return') &&
    sidebar.includes('if (startupSnapshot && projectVersion === 0) return'),
  'startup snapshot is not immediately fetched a second time'
)
check(
  chat.includes('MAX_TOTAL_ATTACHMENT_BYTES = 40 * 1024 * 1024') &&
    chat.includes('for (const file of valid)') &&
    !chat.includes('Promise.all(valid.map'),
  'large attachments are bounded and encoded sequentially to cap peak memory'
)

const activityFixture = Array.from({ length: 24 }, (_, index) => ({
  kind: index % 3 === 0 ? 'command' as const : index % 3 === 1 ? 'file' as const : 'status' as const,
  label: index % 3 === 0 ? `npm run check:${index}` : index % 3 === 1 ? `src/feature-${index}.tsx` : `Stage ${index}`,
  status: index < 20 ? 'complete' as const : 'running' as const,
  timestamp: index + 1
}))
const benchmarkStartedAt = performance.now()
let derivedCount = 0
for (let iteration = 0; iteration < 20_000; iteration += 1) {
  derivedCount += deriveWorkspaceWorkflow({
    prompt: 'Optimize renderer startup, streaming chat, telemetry and navigation without interrupting active work.',
    projectName: 'Akorith',
    activities: activityFixture,
    active: true
  }).length
}
const benchmarkElapsedMs = performance.now() - benchmarkStartedAt
check(derivedCount > 0, 'workflow benchmark exercised real derived steps')
check(benchmarkElapsedMs < 2_000, '20,000 workflow derivations stay below the 2 s regression ceiling')
console.log(`[measure] workflow derivation: ${benchmarkElapsedMs.toFixed(1)} ms / 20,000 iterations`)

if (failures.length > 0) {
  console.error(`\nPerformance verification failed (${failures.length} check${failures.length === 1 ? '' : 's'}).`)
  process.exit(1)
}

console.log('\nPerformance verification passed.')

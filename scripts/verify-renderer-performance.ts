import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..')
const failures: string[] = []

function read(relativePath: string): string {
  return readFileSync(join(root, relativePath), 'utf8')
}

function check(value: unknown, label: string): void {
  if (value) {
    console.log(`[ok] ${label}`)
    return
  }
  failures.push(label)
  console.error(`[fail] ${label}`)
}

const visibility = read('src/renderer/src/documentVisibility.ts')
const research = read('src/renderer/src/components/ResearchPage.tsx')
const researchProgress = read('src/renderer/src/components/ResearchProgress.tsx')
const researchEssay = read('src/renderer/src/components/ResearchEssay.tsx')
const workspaceActivity = read('src/renderer/src/components/WorkspaceActivity.tsx')
const workspaceLoop = read('src/renderer/src/components/WorkspaceLoopActivity.tsx')
const benchmark = read('src/renderer/src/components/BenchmarkExperience.tsx')
const benchmarkPage = read('src/renderer/src/components/BenchmarkPage.tsx')
const sidebar = read('src/renderer/src/components/Sidebar.tsx')
const chatMarkdown = read('src/renderer/src/components/ChatMarkdown.tsx')
const chatMessage = read('src/renderer/src/components/ChatMessageView.tsx')

check(
  visibility.includes('useSyncExternalStore') &&
    visibility.includes("document.addEventListener('visibilitychange', publishVisibility)") &&
    visibility.includes('listeners.size === 0'),
  'mounted features share one document visibility listener'
)
check(
  research.includes('if (!active || !documentVisible) return') &&
    research.includes('next.some((job) => ACTIVE_RESEARCH_STATUSES.has(job.status)) ? 5_000 : 30_000') &&
    research.includes("next.status === 'completed' || next.status === 'archived'"),
  'Research pauses hidden polling and backs off for idle or completed work'
)
check(
  research.includes('sameResearchJobs(current, next) ? current : next') &&
    research.includes('const jobsById = useMemo(() => new Map') &&
    research.includes('const activeIds: string[] = []'),
  'Research preserves unchanged snapshots and indexes repeated job lookups'
)
check(
  research.includes('const runAction = useCallback') &&
    research.includes('onOpenSource={openSource}') &&
    researchProgress.includes('export default memo(ResearchProgress)') &&
    researchEssay.includes('export default memo(ResearchEssay)'),
  'stable Research actions prevent idle list refreshes from rebuilding long essays'
)
check(
  workspaceActivity.includes('if (!active || !documentVisible) return') &&
    workspaceLoop.includes('if (!active || !documentVisible) return'),
  'Workspace clocks and durable goal polling stop while the window is hidden'
)
check(
  benchmark.includes('useDeferredValue(modelSearch)') &&
    benchmark.includes('useDeferredValue(challengeSearch)') &&
    benchmark.includes('const modelsByKey = useMemo(() => new Map') &&
    benchmark.includes('const modelSearchIndex = useMemo') &&
    benchmark.includes('const challengeSearchIndex = useMemo'),
  'Benchmark searches stay responsive and reuse precomputed lookup indexes'
)
check(
  benchmark.includes('const queueState = useMemo') &&
    benchmark.includes('for (const item of queue)') &&
    benchmark.includes('const BENCHMARK_STEPS = ['),
  'Benchmark queue state uses one memoized pass and static workflow metadata'
)
check(
  benchmarkPage.includes('if (!active || !running || !documentVisible) return') &&
    benchmarkPage.includes('const modelOptionsByKey = useMemo') &&
    benchmarkPage.includes('const historyCountsByChallenge = useMemo') &&
    !benchmarkPage.includes('historicalRuns: libraryEntries.filter'),
  'hidden Benchmark clocks stop and model/history lookups use linear-time indexes'
)
check(
  sidebar.includes('const scheduleResponsiveSidebar') &&
    sidebar.includes('window.requestAnimationFrame') &&
    sidebar.includes('window.cancelAnimationFrame(resizeFrame)') &&
    !sidebar.includes("window.addEventListener('resize', syncResponsiveSidebar)"),
  'Sidebar resize work is limited to one responsive update per animation frame'
)
check(
  chatMarkdown.includes('const REMARK_PLUGINS = [remarkGfm]') &&
    chatMarkdown.includes('remarkPlugins={REMARK_PLUGINS}') &&
    chatMessage.includes('for (const attachment of message.attachments ?? [])') &&
    chatMessage.includes('}, [message.attachments])'),
  'streaming messages reuse Markdown configuration and group attachments once'
)

if (failures.length > 0) {
  console.error(`\nRenderer performance verification failed (${failures.length}).`)
  process.exit(1)
}

console.log('\nRenderer performance verification passed (10 optimization groups).')

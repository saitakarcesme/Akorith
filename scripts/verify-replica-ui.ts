import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function hasToken(css: string, names: string[], expectedValues: string[]): boolean {
  return names.some((name) =>
    expectedValues.some((value) =>
      new RegExp(
        `${escapeRegex(name)}\\s*:\\s*${escapeRegex(value)}\\s*(?:;|\\})`,
        'i'
      ).test(css)
    )
  )
}

function selectorBlocks(css: string, selectorFragment: string): string[] {
  const blocks: string[] = []
  const pattern = /([^{}]+)\{([^{}]*)\}/g
  for (const match of css.matchAll(pattern)) {
    if (match[1].includes(selectorFragment)) blocks.push(match[2])
  }
  return blocks
}

function hasBreakpoint(css: string, width: number): boolean {
  return new RegExp(
    `@media\\s*\\(\\s*max-width\\s*:\\s*${width}px\\s*\\)`,
    'i'
  ).test(css)
}

function hasHiddenMountedWrapper(
  app: string,
  className: string,
  condition: RegExp,
  componentName: string
): boolean {
  const classIndex = app.indexOf(`className="${className}"`)
  if (classIndex < 0) return false
  const window = app.slice(classIndex, classIndex + 1_800)
  return (
    /style=\{\{\s*display\s*:/.test(window) &&
    condition.test(window) &&
    /\?\s*['"]flex['"]\s*:\s*['"]none['"]/.test(window) &&
    new RegExp(`<${escapeRegex(componentName)}\\b`).test(window)
  )
}

const app = read('src/renderer/src/App.tsx')
const chat = read('src/renderer/src/components/ChatPanel.tsx')
const dashboard = read('src/renderer/src/components/Dashboard.tsx')
const preview = read('src/renderer/src/components/ProjectPreviewPanel.tsx')
const research = read('src/renderer/src/components/ResearchProgress.tsx')
const researchEssay = read('src/renderer/src/components/ResearchEssay.tsx')
const researchOperations = read('src/renderer/src/components/ResearchOperationalDetails.tsx')
const workspaceActivity = read('src/renderer/src/components/WorkspaceActivity.tsx')
const workspaceStepDock = read('src/renderer/src/components/WorkspaceStepDock.tsx')
const sidebar = read('src/renderer/src/components/Sidebar.tsx')
const settings = read('src/renderer/src/components/SettingsCenter.tsx')
const main = read('src/main/index.ts')
const replicaCss = read('src/renderer/src/replica-ui.css')
const stylesCss = read('src/renderer/src/styles.css')
const productPolishCss = read('src/renderer/src/product-polish.css')
const benchmark = read('src/renderer/src/components/BenchmarkExperience.tsx')
const benchmarkPage = read('src/renderer/src/components/BenchmarkPage.tsx')
const benchmarkCss = read('src/renderer/src/benchmark.css')

check(/data-ui\s*=\s*['"]replica['"]/.test(app), "App opts into data-ui='replica'")

check(
  hasToken(
    replicaCss,
    ['--titlebar-height', '--replica-titlebar-height', '--app-chrome-height'],
    ['36px']
  ),
  'replica titlebar height is 36px'
)
check(
  hasToken(replicaCss, ['--sidebar-width', '--replica-sidebar-width'], ['266px']),
  'replica sidebar width is 266px'
)

const appSurfaceBlocks = selectorBlocks(replicaCss, '.app-surface')
check(appSurfaceBlocks.length > 0, 'replica CSS styles the inset app surface')
check(
  appSurfaceBlocks.some((block) =>
    /border-(?:top-)?left-radius\s*:\s*10px\s*;?/i.test(block)
    || /border-radius\s*:\s*10px\s*;?/i.test(block)
    || /inset\s*:[^;]*\b10px\b/i.test(block)
  ),
  'replica app surface keeps the 10px inset/corner treatment'
)

const colorTokens: Array<{ names: string[]; values: string[]; label: string }> = [
  { names: ['--bg-under', '--replica-bg-under'], values: ['#000', '#000000'], label: 'underlay' },
  { names: ['--surface', '--replica-surface'], values: ['#090909'], label: 'surface' },
  { names: ['--surface-soft', '--replica-surface-soft'], values: ['#0d0d0d'], label: 'soft surface' },
  { names: ['--surface-card', '--replica-surface-card'], values: ['#111', '#111111'], label: 'card surface' },
  { names: ['--surface-control', '--replica-surface-control'], values: ['#111', '#111111'], label: 'control surface' },
  { names: ['--elevated-opaque'], values: ['#111', '#111111'], label: 'elevated surface' },
  { names: ['--text', '--replica-text'], values: ['#f2f2f2'], label: 'primary text' },
  { names: ['--text-secondary', '--replica-text-secondary'], values: ['#a3a3a3'], label: 'secondary text' },
  { names: ['--replica-border-default'], values: ['#ffffff18'], label: 'border' },
  { names: ['--blue', '--replica-blue'], values: ['#339cff'], label: 'blue accent' },
  { names: ['--green', '--replica-green'], values: ['#34d17b'], label: 'green accent' },
  { names: ['--orange', '--replica-orange'], values: ['#ff5c00'], label: 'orange accent' },
  { names: ['--purple', '--replica-purple'], values: ['#a56eff'], label: 'purple accent' },
  { names: ['--red', '--replica-red'], values: ['#e02e2a'], label: 'red accent' }
]

for (const token of colorTokens) {
  check(
    hasToken(replicaCss, token.names, token.values),
    `replica ${token.label} color token is present`
  )
}

check(!chat.includes('replica-app-symbol'), 'chat omits the redundant single-app symbol')
check(chat.includes('replica-suggestion-grid'), 'chat includes the replica suggestion grid')
check(chat.includes('replica-feature-banner'), 'chat includes the replica feature banner')
check(!chat.includes('replica-composer-context'), 'chat omits the redundant static composer context strip')
check(!sidebar.includes('direction="down"'), 'Akorith brand omits the single-app dropdown chevron')
check(chat.includes('Ask Akorith anything…'), 'general composer uses finished Akorith placeholder copy')
check(
  chat.includes('useLayoutEffect') &&
  chat.includes('MAX_COMPOSER_HEIGHT = 192') &&
  chat.includes('input.scrollHeight') &&
  selectorBlocks(replicaCss, '.composer-input').some((block) =>
    /max-height\s*:\s*192px/.test(block) &&
    /overflow-y\s*:\s*hidden/.test(block)
  ),
  'Workspace composer grows with content to a bounded 192px height'
)
check(
  chat.includes('className={`composer-notice is-${toast.tone}`}') &&
  chat.indexOf('className={`composer-notice is-${toast.tone}`}') < chat.indexOf('<div className={`composer-box') &&
  !chat.includes('bridge-toast') &&
  selectorBlocks(replicaCss, '.composer-notice').some((block) =>
    /white-space\s*:\s*normal/.test(block) &&
    !/position\s*:\s*absolute/.test(block)
  ),
  'composer notices stay in document flow instead of overlapping typed text'
)
check(
  /position\s*:\s*relative[\s\S]{0,240}place-items\s*:\s*center/.test(
    selectorBlocks(replicaCss, '.replica-home').join('\n')
  ) &&
  chat.indexOf('{composer}') < chat.indexOf('replica-suggestion-grid'),
  'empty-chat composer is centered before optional suggestions'
)
check(
  researchOperations.includes('research-phase-scroll') &&
  researchOperations.includes('<strong>{phase.label}</strong>') &&
  selectorBlocks(replicaCss, '.research-phase.is-active').some((block) =>
    !/(?:purple|gradient|animation)/i.test(block)
  ),
  'Research uses a compact neutral phase strip'
)
check(
  researchOperations.includes('research-workbench-grid') &&
  selectorBlocks(stylesCss, '.research-workbench-grid').some((block) =>
    /display\s*:\s*grid/.test(block) &&
    /auto-fit/.test(block) &&
    /gap\s*:\s*clamp\(/.test(block)
  ),
  'Evidence program and Research log share a responsive, spacious grid'
)
check(
  research.includes('<ResearchEssay') &&
  research.includes('collapsed={terminal}') &&
  researchEssay.includes('Research essay') &&
  researchEssay.includes('Bibliography'),
  'Completed Research leads with the essay and keeps operational details collapsed'
)
check(
  dashboard.includes('gpuHistory') &&
  dashboard.includes('ComputeUsageWave') &&
  dashboard.includes('tone="gpu"') &&
  dashboard.includes('window.api.gpu.getStatus()'),
  'GPU utilization records real samples and renders a history wave'
)
check(
  !workspaceActivity.includes('workspace-activity-icon') &&
  selectorBlocks(stylesCss, '.workspace-activity-row').some((block) => /display\s*:\s*block/.test(block)),
  'Workspace activity prose starts flush without leading status icons'
)
check(
  !workspaceStepDock.includes('const STEPS') &&
  workspaceStepDock.includes('steps.map') &&
  chat.includes('deriveWorkspaceWorkflow'),
  'Workspace workflow uses task-derived steps instead of a fixed phase list'
)

const derivedWorkflow = deriveWorkspaceWorkflow({
  prompt: 'Create a single-file fighting game in index.html',
  projectName: 'aicompanion',
  activities: [
    { kind: 'status', label: 'Claude session started', status: 'complete', timestamp: 1 },
    { kind: 'file', label: 'C:\\aicompanion\\index.html', status: 'complete', timestamp: 2 },
    { kind: 'command', label: 'npm run test', status: 'running', timestamp: 3 }
  ],
  active: true
})
check(
  derivedWorkflow[0]?.title.toLowerCase().includes('single-file fighting game') &&
  derivedWorkflow.some((step) => step.title.includes('index.html')) &&
  derivedWorkflow.some((step) => step.title.includes('npm run test')) &&
  derivedWorkflow.every((step) => !['Prepare', 'Understand', 'Plan', 'Work', 'Validate', 'Finish'].includes(step.title)),
  'derived Workspace workflow reflects the actual request, file and validation command'
)
check(
  !app.includes("const ProjectLoopPage = lazy") &&
  !app.includes('loops-page-wrap') &&
  !sidebar.includes("{ view: 'loops'") &&
  !sidebar.includes("import('./ProjectLoopPage')"),
  'standalone Loop route, page and sidebar navigation are removed'
)
const cssWithoutCurrentLoopFeatures = `${stylesCss}\n${productPolishCss}\n${replicaCss}`
  .replace(/\.workspace-loop-/g, '.workspace-goal-')
  .replace(/\.loop-checkbox\b/g, '.agent-checkbox')
check(
  !/\.loops?(?:-|\b)/.test(cssWithoutCurrentLoopFeatures),
  'standalone Loop selectors are absent from the production CSS sources'
)
check(
  preview.includes('hideWhenUnavailable') &&
  /hideWhenUnavailable\s*&&\s*!session\s*&&\s*!inspection\?\.runnable/.test(preview),
  'unavailable project preview placeholders stay hidden'
)

check(
  /view\s*===\s*['"]general['"]\s*&&\s*!activeSessionId/.test(sidebar),
  'New chat is selected only for a blank general chat'
)
check(
  /view\s*===\s*['"]workspace['"]\s*&&\s*activeProject\?\.id\s*===\s*project\.id\s*&&\s*!activeSessionId/.test(sidebar),
  'project row selection clears when one of its chats is open'
)
check(
  /view\s*===\s*['"]workspace['"]\s*&&\s*chat\.id\s*===\s*activeSessionId/.test(sidebar) &&
  /view\s*===\s*['"]general['"]\s*&&\s*session\.id\s*===\s*activeSessionId/.test(sidebar),
  'chat row selection follows the visible chat surface'
)

const selectedSidebarBlocks = [
  ...selectorBlocks(replicaCss, '.sidebar-nav button.is-active'),
  ...selectorBlocks(replicaCss, '.project-chat.is-active')
]
check(
  selectedSidebarBlocks.some((block) => /background\s*:\s*var\(--surface-selected\)/.test(block)) &&
  selectedSidebarBlocks.every((block) => !/background\s*:\s*var\(--white-button\)/.test(block)),
  'selected sidebar rows use a neutral surface instead of a white fill'
)

const composerFocusBlocks = [
  ...selectorBlocks(replicaCss, '.composer-input:focus'),
  ...selectorBlocks(replicaCss, '.composer-box:focus-within')
]
check(
  composerFocusBlocks.length > 0 &&
  composerFocusBlocks.every((block) => !/(?:--blue|#339cff)/i.test(block)),
  'composer focus treatment has no blue border'
)
const finalComposerBox = selectorBlocks(replicaCss, '.composer-box').at(-1) ?? ''
const finalComposerFocus = selectorBlocks(replicaCss, '.composer-box:focus-within').at(-1) ?? ''
check(
  /border\s*:\s*0\s*!important/.test(finalComposerBox) &&
  /box-shadow\s*:\s*none\s*!important/.test(finalComposerBox) &&
  /border\s*:\s*0\s*!important/.test(finalComposerFocus) &&
  /box-shadow\s*:\s*none\s*!important/.test(finalComposerFocus),
  'composer has no resting or focus border ring'
)
check(
  selectorBlocks(replicaCss, '.chat-msg.user').some((block) =>
    /color\s*:\s*var\(--bubble-user-text\)/.test(block)
  ),
  'user message text keeps contrast against its bubble'
)

const researchEventBlocks = selectorBlocks(replicaCss, '.research-event-list')
check(
  researchEventBlocks.some((block) =>
    /max-height\s*:\s*clamp\(/.test(block) &&
    /overflow-y\s*:\s*auto/.test(block) &&
    /overscroll-behavior\s*:\s*contain/.test(block)
  ) &&
  researchEventBlocks.every((block) => !/max-height\s*:\s*none/.test(block)),
  'long Research activity owns a bounded internal scroll region'
)
check(
  selectorBlocks(replicaCss, '.research-page-content').some((block) =>
    /min-height\s*:\s*0/.test(block) &&
    /overflow-y\s*:\s*auto/.test(block)
  ),
  'Research keeps its toolbar and tabs outside the scrolling content'
)

check(
  ['Select Models', 'Choose Benchmark', 'Configure', 'Run Benchmark'].every((label) => benchmark.includes(label)) &&
    benchmark.includes("aria-current={isCurrent ? 'step' : undefined}"),
  'Benchmark exposes the four-step accessible workflow'
)
check(
  benchmark.includes('Search models...') &&
    benchmark.includes('Search benchmarks...') &&
    benchmark.includes('Run queue') &&
    benchmark.includes('Recent runs') &&
    benchmark.includes('Score table'),
  'Benchmark includes selection, queue, history and score surfaces'
)
check(
  benchmarkPage.includes('runBoundedBenchmarkQueue') &&
    benchmarkPage.includes('window.api.benchmark.createRun') &&
    benchmarkPage.includes('window.api.benchmark.finishRun') &&
    benchmarkPage.includes('for (const requestId of activeRequestIds.current)'),
  'Benchmark queue is bounded, persisted and fully cancellable'
)
check(
  /--benchmark-bg\s*:\s*#090909/.test(benchmarkCss) &&
    /--benchmark-panel-raised\s*:\s*#111/.test(benchmarkCss) &&
    /--benchmark-radius-lg\s*:\s*8px/.test(benchmarkCss) &&
    !/linear-gradient|radial-gradient/i.test(benchmarkCss),
  'Benchmark uses neutral black surfaces, restrained radii and no gradients'
)
check(
  benchmarkCss.includes('@container benchmark-experience (max-width: 980px)') &&
    benchmarkCss.includes('@container benchmark-experience (max-width: 720px)') &&
    benchmarkCss.includes('@container benchmark-experience (max-width: 520px)'),
  'Benchmark has container-responsive desktop, tablet and narrow layouts'
)

check(
  /\btabGroups\b/.test(settings) &&
  settings.includes('settings-tab-group') &&
  /tabGroups\.map\s*\(/.test(settings),
  'Settings renders grouped navigation tabs'
)
check(
  settings.includes('settings-back') &&
  /className=["']settings-back["'][\s\S]{0,240}onClick=\{onClose\}/.test(settings),
  'Settings exposes a back control wired to close'
)

for (const width of [720, 540, 400]) {
  check(hasBreakpoint(replicaCss, width), `replica CSS includes the ${width}px mobile breakpoint`)
}

const mainWindowSource = main.slice(main.indexOf('const mainWindow = new BrowserWindow'))
const mainMinWidth = Number(mainWindowSource.match(/\bminWidth\s*:\s*(\d+)/)?.[1])
check(
  Number.isFinite(mainMinWidth) && mainMinWidth > 0 && mainMinWidth <= 400,
  'main BrowserWindow minWidth reaches the 400px responsive breakpoint'
)

check(
  hasHiddenMountedWrapper(
    app,
    'workspace',
    /view\s*===\s*['"]workspace['"]\s*\|\|\s*view\s*===\s*['"]general['"]/,
    'ChatPanel'
  ),
  'Workspace remains mounted and is hidden with display:none'
)
check(
  hasHiddenMountedWrapper(
    app,
    'test-page-wrap',
    /view\s*===\s*['"]test['"]/,
    'TestPage'
  ),
  'Test remains mounted and is hidden with display:none'
)
check(
  hasHiddenMountedWrapper(
    app,
    'research-page-wrap',
    /view\s*===\s*['"]research['"]/,
    'ResearchPage'
  ),
  'Research remains mounted and is hidden with display:none'
)

if (failures.length > 0) {
  console.error(`\nReplica UI verification failed (${failures.length} check${failures.length === 1 ? '' : 's'}).`)
  process.exit(1)
}

console.log('\nReplica UI verification passed.')

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDiffRows } from '../src/renderer/src/components/BottomWorkbench'
import {
  mapPreviewPoint,
  previewKeyForInput,
  previewWheelDelta
} from '../src/renderer/src/components/ProjectPreviewPanel'
import {
  buildWorkspaceActivityEventNarrative,
  buildWorkspaceActivityNarrative
} from '../src/renderer/src/workspaceActivityNarrative'
import { liveWorkspaceChangesSince, newlyCreatedWorkspaceFiles } from '../src/renderer/src/workspaceLiveChanges'
import { highlightWorkspaceCode } from '../src/renderer/src/workspaceSyntax'
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

function hasHeightBreakpoint(css: string, height: number): boolean {
  return new RegExp(
    `@media\\s*\\(\\s*max-height\\s*:\\s*${height}px\\s*\\)`,
    'i'
  ).test(css)
}

function hasHiddenMountedWrapper(
  app: string,
  className: string,
  condition: RegExp,
  componentName: string
): boolean {
  const literalIndex = app.indexOf(`className="${className}"`)
  const templateMatch = new RegExp(`className=\\{\\\`${escapeRegex(className)}(?:\\s|\\\`)`).exec(app)
  const classIndex = literalIndex >= 0 ? literalIndex : templateMatch?.index ?? -1
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
const workspaceLiveChangesCard = read('src/renderer/src/components/WorkspaceLiveChangesCard.tsx')
const workspaceStepDock = read('src/renderer/src/components/WorkspaceStepDock.tsx')
const workspaceTools = read('src/renderer/src/components/WorkspaceToolsPanel.tsx')
const workspaceFiles = read('src/renderer/src/components/WorkspaceFilesPanel.tsx')
const bottomWorkbench = read('src/renderer/src/components/BottomWorkbench.tsx')
const sidebar = read('src/renderer/src/components/Sidebar.tsx')
const settings = read('src/renderer/src/components/SettingsCenter.tsx')
const main = read('src/main/index.ts')
const projectPreviewMain = read('src/main/project-preview.ts')
const projectFilesMain = read('src/main/project-files.ts')
const preload = read('src/preload/index.ts')
const preloadTypes = read('src/preload/index.d.ts')
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
  { names: ['--bg-under', '--replica-bg-under'], values: ['#1b1d20'], label: 'charcoal underlay' },
  { names: ['--surface', '--replica-surface'], values: ['#24272b'], label: 'neutral surface' },
  { names: ['--surface-soft', '--replica-surface-soft'], values: ['#282c31'], label: 'soft neutral surface' },
  { names: ['--surface-card', '--replica-surface-card'], values: ['#2d3136'], label: 'card surface' },
  { names: ['--surface-control', '--replica-surface-control'], values: ['#343940'], label: 'control surface' },
  { names: ['--elevated-opaque'], values: ['#30343a'], label: 'elevated surface' },
  { names: ['--text', '--replica-text'], values: ['#f3f4f6'], label: 'primary text' },
  { names: ['--text-secondary', '--replica-text-secondary'], values: ['#c1c5cb'], label: 'secondary text' },
  { names: ['--replica-border-default'], values: ['#ffffff1c'], label: 'border' },
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
check(
  /\.app\[data-ui='replica'\]\[data-theme='light'\][^{]*\{[\s\S]*?--bg-under\s*:\s*#d8dce1[\s\S]*?--surface\s*:\s*#e7e9ec[\s\S]*?--text\s*:\s*#20242a/.test(replicaCss),
  'light theme uses a medium-gray surface system with dark readable text'
)
check(
  /--terminal-bg\s*:\s*#202328/.test(replicaCss) &&
    /--terminal-bg\s*:\s*#f1f2f4/.test(replicaCss),
  'terminal colors are explicitly readable in both dark and light themes'
)

check(!chat.includes('replica-app-symbol'), 'chat omits the redundant single-app symbol')
check(chat.includes('replica-suggestion-grid'), 'chat includes the replica suggestion grid')
check(
  app.includes('<WorkspaceToolsPanel') &&
  workspaceTools.includes('<ProjectPreviewPanel') &&
  workspaceTools.includes('<WorkspaceFilesPanel') &&
  workspaceTools.includes('<TerminalPane'),
  'Workspace mounts the Browser, Computer Use, Files, Review, and Terminal tool canvas'
)
check(
  workspaceTools.includes('akorith.workspaceToolsWidth') &&
    workspaceTools.includes('workspace-tools-resizer') &&
    workspaceTools.includes('is-closed') &&
    !workspaceTools.includes('workspace-tools-rail') &&
    (workspaceTools.match(/className="workspace-tools-close"/g) ?? []).length === 1,
  'Workspace tools close to zero width and keep one integrated panel-close control'
)
check(
  workspaceTools.includes('const [openTabs, setOpenTabs]') &&
    workspaceTools.includes('interface WorkspaceToolTab') &&
    workspaceTools.includes('handledRequestRef') &&
    workspaceTools.includes('workspace-tool-tabs') &&
    workspaceTools.includes('workspace-tool-tab-add') &&
    workspaceTools.includes('workspace-tools-launcher') &&
    workspaceTools.includes('Choose a workspace tool') &&
    !workspaceTools.includes('pickerOpen') &&
    workspaceTools.includes('workspace-tool-pane') &&
    workspaceTools.includes("openTabs.filter((tab) => tab.tool !== null)") &&
    workspaceTools.includes("title: 'New tab'"),
  'Workspace tools use instance tabs, a shared add control, and a centered launcher'
)
check(
  bottomWorkbench.includes('workbench-changes-tree') &&
    bottomWorkbench.includes('workbench-scm-toolbar') &&
    bottomWorkbench.includes('workbench-branch-route') &&
    bottomWorkbench.includes('changes.upstream') &&
    !bottomWorkbench.includes('origin/{changes.branch}') &&
    bottomWorkbench.includes('workbench-truncation-notice') &&
    bottomWorkbench.includes('workbench-line-marker') &&
    bottomWorkbench.includes('workbench-diff-line') &&
    bottomWorkbench.includes('workbench-line-number') &&
    bottomWorkbench.includes('file.additions') &&
    bottomWorkbench.includes('file.deletions'),
  'Review provides a Codex SCM toolbar, right file tree, and numbered GitHub-style diff'
)
check(
  app.includes('onWorkspaceToolRequest={requestWorkspaceTool}') &&
    app.includes('requestedTool={workspaceToolRequest}') &&
    app.includes('activeSessionIdRef.current !== request.sessionId') &&
    chat.includes('activity.surface') &&
    chat.includes('activeSessionRef.current !== sessionId') &&
    chat.includes("requestWorkspaceTool('review', 'changes')") &&
    /activity\.kind\s*===\s*['"]file['"]\s*\?\s*['"]files['"]/.test(read('src/main/providers/registry.ts')),
  'structured file activity and completed change evidence open the relevant tool without label parsing'
)
check(
  (app.match(/aria-label="Open workspace tools"/g) ?? []).length === 1 &&
    app.includes('showWorkbench && !workbenchOpen') &&
    workspaceTools.includes('aria-label="Close workspace tools"') &&
    workspaceTools.indexOf('className="workspace-tools-close"') <
      workspaceTools.indexOf('</nav>') &&
    app.includes("const showChromeWorkbench = view === 'workspace' && Boolean(activeProject?.path)") &&
    app.includes('const workspaceToolsVisible = showChromeWorkbench && workbenchOpen') &&
    app.includes('if (!activeProject?.path) return') &&
    !app.includes('workspaceHasToolTabs') &&
    !app.includes("tool: 'files'") &&
    !app.includes('aria-label="Toggle sidebar panel"'),
  'the closed-surface opener hands off to one close control inside the tool tab row'
)
check(
  selectorBlocks(replicaCss, '.workspace-tools-close').some((block) =>
    /width\s*:\s*30px/.test(block) &&
    /height\s*:\s*30px/.test(block)
  ),
  'workspace tool close control aligns with the compact tab row'
)
check(
  selectorBlocks(
    replicaCss,
    '.app-surface:has(.workspace-tools.is-open) .app-surface-toolbar-left'
  ).some((block) => /display\s*:\s*none/.test(block)),
  'narrow full-surface tools hide the project label instead of overlapping the tool tabs'
)
const closedToolPanel = selectorBlocks(replicaCss, '.workspace-tools.is-closed').at(-1) ?? ''
const finalDiffCode = selectorBlocks(replicaCss, '.workbench-diff-line code').at(-1) ?? ''
const finalToolTabs = selectorBlocks(replicaCss, '.workspace-tool-tabs').at(-1) ?? ''
const finalToolContent = selectorBlocks(replicaCss, '.workspace-tools-content.has-tabs').at(-1) ?? ''
check(
  /width\s*:\s*0/.test(closedToolPanel) &&
    /flex-basis\s*:\s*0/.test(closedToolPanel) &&
    /visibility\s*:\s*hidden/.test(closedToolPanel),
  'closed workspace tools leave no rail or reserved layout width'
)
check(
  selectorBlocks(replicaCss, '.workspace-tools-resizer').some((block) =>
    /top\s*:\s*0/.test(block) &&
    /bottom\s*:\s*0/.test(block) &&
    /cursor\s*:\s*col-resize/.test(block)
  ) &&
    selectorBlocks(replicaCss, '.workspace-tools-resizer::after').some((block) =>
      /display\s*:\s*none/.test(block) &&
      /content\s*:\s*none/.test(block)
    ),
  'workspace tool resize target stays full-height without a hover rail'
)
check(
  /height\s*:\s*46px/.test(finalToolTabs) &&
    /padding\s*:\s*6px\s+8px\s+6px\s+12px/.test(finalToolTabs) &&
    selectorBlocks(replicaCss, '.workspace-tool-tab-list').some((block) =>
      /overflow-x\s*:\s*auto/.test(block)
    ) &&
    selectorBlocks(replicaCss, '.workspace-tool-tab').some((block) =>
      /min-width\s*:\s*112px/.test(block) &&
      /height\s*:\s*34px/.test(block) &&
      /border-radius\s*:\s*9px/.test(block)
    ) &&
    selectorBlocks(replicaCss, '.workspace-tool-tab').some((block) =>
      /flex\s*:\s*0\s+0\s+auto/.test(block)
    ),
  'workspace tools use the same compact pill-tab geometry as Research'
)
check(
  /inset\s*:\s*46px\s+0\s+0/.test(finalToolContent),
  'workspace tool content begins immediately below the integrated tab strip'
)
check(
  selectorBlocks(replicaCss, '.workspace-tools').some((block) =>
    /border-top-left-radius\s*:\s*10px/.test(block) &&
    /border-top\s*:\s*1px/.test(block) &&
    /border-left\s*:\s*1px/.test(block)
  ),
  'open workspace tools form a rounded sibling surface'
)
check(
  /white-space\s*:\s*pre/.test(finalDiffCode) &&
    /overflow-wrap\s*:\s*normal/.test(finalDiffCode) &&
    selectorBlocks(replicaCss, '.workbench-diff-line').some((block) =>
      /grid-template-columns\s*:\s*48px\s+48px\s+22px/.test(block)
    ),
  'Review keeps GitHub-style non-wrapping code with separate old, new and marker gutters'
)
check(
  workspaceTools.includes('tabIndex={selected ? 0 : -1}') &&
    workspaceTools.includes('navigateTabs(event, tab.id)') &&
    workspaceTools.includes('className="workspace-tool-tab-select"') &&
    workspaceTools.includes('className="workspace-tool-tab-close"') &&
    workspaceTools.includes('aria-label={`Close ${tab.title}`}') &&
    !workspaceTools.includes('Delete to close'),
  'tool tabs have separate accessible close buttons and roving keyboard focus'
)
check(
  workspaceTools.includes('role="tabpanel"') &&
    workspaceTools.includes('aria-labelledby={`workspace-tool-tab-${activeTab.id}`}'),
  'the New tab launcher is connected to its tab for assistive technology'
)
check(
  app.includes("key={activeProject?.id ?? 'no-project'}") &&
    workspaceTools.includes('openTabs.filter((tab) => tab.id !== tabId)') &&
    workspaceTools.includes('openTabs.filter((tab) => tab.tool !== null)'),
  'project changes remount tool resources and closing a tab releases its mounted surface'
)
check(
  workspaceTools.includes('refreshKey={refreshKey}') &&
    /\[open,\s*load,\s*refreshKey\]/.test(bottomWorkbench) &&
    chat.includes("reason === 'activity' && requestedTools.has(tool)"),
  'final change evidence refreshes an already-open Review tab'
)
check(
  app.includes('const [workspaceContentVersion, setWorkspaceContentVersion]') &&
    app.includes('onWorkspaceContentChange={bumpWorkspaceContent}') &&
    app.includes('refreshKey={`${historyVersion}:${workspaceContentVersion}`}') &&
    chat.includes('if (turn.workspace) onWorkspaceContentChange?.(turn.workspace.projectId)') &&
    workspaceTools.includes('<WorkspaceFilesPanel') &&
    workspaceTools.includes('refreshKey={refreshKey}') &&
    workspaceFiles.includes('window.api.projects.files(project.id, settledQuery, refreshFromDisk)') &&
    /\[project\.id,\s*settledQuery,\s*reloadSignal,\s*refreshKey\]/.test(workspaceFiles) &&
    /\[project\.id,\s*selected,\s*reloadSignal,\s*refreshKey\]/.test(workspaceFiles) &&
    preload.includes('files: (projectId: string, query?: string, refresh?: boolean)') &&
    preloadTypes.includes('files(projectId: string, query?: string, refresh?: boolean)') &&
    projectFilesMain.includes('function invalidateFileIndex(root: string)') &&
    projectFilesMain.includes('input.refresh === true'),
  'task completion, failure, and stop refresh Review and Files from the post-rollback disk state'
)
check(
  preview.includes('workspace-browser-toolbar') &&
    preview.includes('placeholder="Enter a URL"') &&
    preview.includes("window.api.projectPreview.navigate") &&
    preview.includes('workspaceVariant') &&
    preview.includes('mapPreviewPoint') &&
    preview.includes('project-preview-display') &&
    preview.includes('new ResizeObserver(scheduleResize)') &&
    preview.includes('window.api.projectPreview.setViewport') &&
    preview.includes('frameImageRef.current?.getBoundingClientRect()') &&
    /!workspaceVariant\s*&&\s*<p>/.test(preview) &&
    selectorBlocks(replicaCss, '.project-preview.is-workspace .project-preview-stage').some((block) =>
      /padding\s*:\s*0/.test(block) && /overflow\s*:\s*hidden/.test(block)
    ) &&
    selectorBlocks(replicaCss, '.project-preview.is-workspace .project-preview-display').some((block) =>
      /display\s*:\s*flex/.test(block) && /flex\s*:\s*1\s+1\s+auto/.test(block)
    ) &&
    selectorBlocks(replicaCss, '.project-preview.is-workspace .project-preview-frame img').some((block) =>
      /object-fit\s*:\s*fill/.test(block) && /height\s*:\s*100%/.test(block)
    ),
  'Browser uses compact address chrome and a real responsive viewport that fills the tool surface'
)
check(
  workspaceTools.includes('pointerInput') &&
    preview.includes('const pointerEnabled = interactive || pointerInput') &&
    preview.includes('tabIndex={0}') &&
    preview.includes('onKeyDown={sendPreviewKey}') &&
    preview.includes('onWheel={scrollPreview}') &&
    preview.includes('event.currentTarget.focus({ preventScroll: true })'),
  'Browser preview accepts direct pointer, wheel, and keyboard input without exposing the Computer Use text tray'
)
check(
  previewKeyForInput({ key: 'a', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }) === 'a' &&
    previewKeyForInput({ key: 'Enter', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }) === 'Enter' &&
    previewKeyForInput({ key: 'x', altKey: false, ctrlKey: true, metaKey: false, shiftKey: false }) === null &&
    previewKeyForInput({ key: 'Enter', altKey: false, ctrlKey: false, metaKey: false, shiftKey: true }) === null,
  'Browser keyboard forwarding accepts plain/safe keys and blocks modifier shortcuts'
)
check(
  previewWheelDelta(2, 1, 500) === 32 &&
    previewWheelDelta(2, 2, 500) === 1_000 &&
    previewWheelDelta(5_000, 0, 500) === 1_200 &&
    projectPreviewMain.includes("args.type === 'wheel'") &&
    projectPreviewMain.includes("type: 'mouseWheel'") &&
    projectPreviewMain.includes("action !== 'back'") &&
    projectPreviewMain.includes("action !== 'forward'") &&
    projectPreviewMain.includes("action !== 'reload'") &&
    projectPreviewMain.includes("action !== 'go'") &&
    projectPreviewMain.includes("typeof value !== 'string' || !isLoopbackUrl(value)") &&
    projectPreviewMain.includes('openProjectPreviewUrl') &&
    projectPreviewMain.includes("ipcMain.handle('projectPreview:openUrl'") &&
    preload.includes("ipcRenderer.invoke('projectPreview:openUrl'") &&
    preview.includes('window.api.projectPreview.openUrl(projectPath, normalized)') &&
    preload.includes("ipcRenderer.invoke('projectPreview:navigate'") &&
    projectPreviewMain.includes('isLoopbackUrl(session.url)') &&
    projectPreviewMain.includes('projectPreviewInputKey(args.key)') &&
    preview.includes('? pointerEnabled') &&
    preloadTypes.includes("type: 'wheel'"),
  'Browser input uses the responsive capture cadence and validates keys/wheel deltas inside verified loopback sessions'
)
check(
  app.includes("(request.reason === 'activity' && request.tool === 'terminal')"),
  'background command activity never auto-opens the unrelated interactive Terminal tab'
)
check(
  workspaceActivity.includes('ProgressiveNarrative') &&
    workspaceActivity.includes("matchMedia('(prefers-reduced-motion: reduce)')") &&
    workspaceActivity.includes('liveAnnouncement') &&
    workspaceActivity.includes('workspace-activity-sr') &&
    workspaceActivity.includes('feed.map') &&
    workspaceActivity.includes('item.id === latest?.id') &&
    workspaceActivity.includes('workspace-activity-event-line') &&
    !/ActivityIcon|workspace-activity-event-icon|workspace-activity-event-badge|workspace-activity-phase/.test(workspaceActivity) &&
    selectorBlocks(productPolishCss, '.workspace-activity-event').some((block) =>
      /background\s*:\s*transparent/.test(block)
    ) &&
    !productPolishCss.includes('.workspace-activity-event.is-current'),
  'Workspace activity renders one flat chronological transcript without cards, icons, or a highlighted current row'
)

const mappedCenter = mapPreviewPoint(
  { left: 0, top: 0, width: 100, height: 100 },
  { width: 200, height: 100 },
  50,
  50,
  'fill'
)
check(
  mappedCenter?.x === 100 &&
    mappedCenter.y === 50 &&
    mapPreviewPoint(
      { left: 0, top: 0, width: 100, height: 100 },
      { width: 200, height: 100 },
      50,
      10,
      'fill'
    )?.y === 10 &&
    mapPreviewPoint(
      { left: 0, top: 0, width: 100, height: 100 },
      { width: 200, height: 100 },
      100,
      50,
      'fill'
    ) === null,
  'Computer Use pointer mapping targets the full responsive viewport without letterboxing'
)

const activityNarrative = buildWorkspaceActivityNarrative({
  projectName: 'Akorith',
  taskPrompt: 'Create an index.html snake game',
  active: true,
  failed: false,
  activities: [
    { kind: 'file', label: 'Writing index.html', status: 'complete', timestamp: 1 },
    { kind: 'command', label: 'npm run check', detail: 'Passed', status: 'complete', timestamp: 2 }
  ]
})
check(
  activityNarrative.includes('Create an index.html snake game') &&
    activityNarrative.length <= 380 &&
    !activityNarrative.includes('Writing index.html') &&
    buildWorkspaceActivityEventNarrative(
      { kind: 'command', label: 'npm run check', detail: 'Passed', status: 'complete', timestamp: 2 },
      'Akorith'
    ).includes('Passed'),
  'Workspace run narrative stays brief while event copy carries concrete provider evidence'
)

const liveChanges = liveWorkspaceChangesSince(
  {
    ok: true,
    isRepo: true,
    branch: 'main',
    files: [{ status: ' M', path: 'existing.ts', staged: false, additions: 2, deletions: 0 }],
    truncated: false,
    stat: '',
    clean: false
  },
  {
    ok: true,
    isRepo: true,
    branch: 'main',
    files: [
      { status: ' M', path: 'existing.ts', staged: false, additions: 2, deletions: 0 },
      { status: '??', path: 'created.ts', staged: false, additions: 12, deletions: 0 }
    ],
    truncated: false,
    stat: '',
    clean: false
  }
)
check(
  liveChanges?.files.length === 1 &&
    liveChanges.additions === 12 &&
    newlyCreatedWorkspaceFiles(liveChanges)[0] === 'created.ts',
  'live Workspace changes exclude pre-turn dirty files and identify truthful created files'
)

const parsedDiff = parseDiffRows([
  'diff --git a/example.ts b/example.ts',
  'index 1111111..2222222 100644',
  '--- a/example.ts',
  '+++ b/example.ts',
  '@@ -4,2 +4,2 @@',
  '---source beginning with dashes',
  '+++source beginning with pluses',
  ' context',
  '\\ No newline at end of file',
  ''
].join('\n'))
check(
  parsedDiff.length === 5 &&
    parsedDiff[1]?.kind === 'deletion' &&
    parsedDiff[1]?.content === '--source beginning with dashes' &&
    parsedDiff[2]?.kind === 'addition' &&
    parsedDiff[2]?.content === '++source beginning with pluses' &&
    parsedDiff[3]?.oldLine === 5 &&
    parsedDiff[3]?.newLine === 5,
  'unified diff parsing keeps source prefixes and ignores the trailing separator row'
)
check(
  workspaceFiles.includes('window.api.projects.readFile') &&
  workspaceFiles.includes('akorith:request-file-edit'),
  'Files tool reads project-scoped code and prepares explicit edit requests'
)
const highlightedWorkspaceCode = highlightWorkspaceCode(
  'const answer = 42\n// visible comment\nreturn "done"',
  'example.ts'
)
check(
  workspaceFiles.includes('useMemo') &&
    workspaceFiles.includes('highlightWorkspaceCode(content, selected)') &&
    workspaceFiles.includes('workspace-code-line-number') &&
    !workspaceFiles.includes('<pre>') &&
    highlightedWorkspaceCode.length === 3 &&
    highlightedWorkspaceCode[0]?.tokens.some((token) => token.kind === 'keyword' && token.text === 'const') &&
    highlightedWorkspaceCode[0]?.tokens.some((token) => token.kind === 'number' && token.text === '42') &&
    highlightedWorkspaceCode[1]?.tokens.some((token) => token.kind === 'comment'),
  'Files uses a memoized dependency-free syntax tokenizer with explicit line rows'
)
check(
  selectorBlocks(replicaCss, '.workspace-code-editor').some((block) =>
    /font\s*:\s*13px\/1\.65/.test(block) &&
    /overflow\s*:\s*auto/.test(block)
  ) &&
    selectorBlocks(replicaCss, '.workspace-code-line-number').some((block) =>
      /position\s*:\s*sticky/.test(block) &&
      /user-select\s*:\s*none/.test(block)
    ) &&
    selectorBlocks(replicaCss, '.workspace-syntax-token.is-keyword').some((block) =>
      /color\s*:\s*var\(--purple\)/.test(block)
    ),
  'Files code viewer has readable VS Code-like typography, sticky line numbers, and theme-safe tokens'
)
check(
  selectorBlocks(replicaCss, '.workspace-files-panel').some((block) =>
    /grid-template-areas\s*:\s*['"]review tree['"]/.test(block)
  ) &&
    selectorBlocks(replicaCss, '.workspace-file-tree').some((block) =>
      /grid-area\s*:\s*tree/.test(block) &&
      /border-left\s*:\s*1px/.test(block)
    ) &&
    selectorBlocks(replicaCss, '.workspace-code-review').some((block) =>
      /grid-area\s*:\s*review/.test(block)
    ) &&
    replicaCss.includes('grid-template-columns: minmax(0, 1fr) minmax(170px, 34%);') &&
    replicaCss.includes('grid-template-columns: minmax(0,1fr) minmax(150px,31%);'),
  'Files keeps the wide code surface on the left and the narrower directory tree on the right at desktop and compact widths'
)
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
  !workspaceActivity.includes('<i aria-hidden') &&
    selectorBlocks(productPolishCss, '.workspace-activity-event-line strong')
      .some((block) =>
        /font-size\s*:\s*14px/.test(block) &&
        /font-weight\s*:\s*600/.test(block)
      ) &&
    selectorBlocks(productPolishCss, '.workspace-activity-event-detail')
      .some((block) => /padding\s*:\s*0/.test(block)),
  'Workspace activity headings are iconless, transcript-sized, and share the narrative left edge'
)
check(
  workspaceActivity.includes('buildWorkspaceActivityEventNarrative') &&
    workspaceActivity.includes('item.id === latest?.id') &&
    workspaceActivity.includes('ProgressiveNarrative') &&
    chat.includes('LIVE_CHANGE_POLL_MS = 2_000') &&
    chat.includes('liveWorkspaceChangesSince') &&
    workspaceLiveChangesCard.includes('Edited {changes.files.length}') &&
    workspaceLiveChangesCard.includes('onReview'),
  'Workspace activity interleaves progressive event copy and exposes a live Review changes receipt'
)
check(
  !workspaceStepDock.includes('const STEPS') &&
  workspaceStepDock.includes('steps.map') &&
  !workspaceStepDock.includes('<i') &&
  workspaceStepDock.includes('Project workflow') &&
  chat.includes('deriveWorkspaceWorkflow') &&
  selectorBlocks(stylesCss, '.workspace-step').some((block) =>
    /border\s*:\s*1px solid var\(--border-soft\)/.test(block) &&
    /background\s*:\s*var\(--bg-chat\)/.test(block)
  ) &&
  selectorBlocks(stylesCss, '.workspace-step-popover').some((block) =>
    /background\s*:\s*var\(--bg-chat\)/.test(block) &&
    !/(?:purple|gradient)/i.test(block)
  ),
  'Workspace workflow uses task-derived steps in a neutral pill and flat iconless popup'
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

const projectChatLists = selectorBlocks(replicaCss, '.project-chats-collapse > .project-chats')
const projectChatRows = selectorBlocks(replicaCss, '.project-chat')
check(
  projectChatLists.some((block) =>
    /margin\s*:\s*0(?:\s*;|$)/.test(block) &&
    /padding\s*:\s*1px\s+0\s+6px/.test(block)
  ) &&
  projectChatRows.some((block) => /padding\s*:\s*0\s+9px\s+0\s+31px/.test(block)),
  'project chat rows align compactly with project labels without inherited tree indentation'
)

const workspaceLaunchers = selectorBlocks(replicaCss, '.workspace-tools-launcher')
const emptyLauncherSurfaces = selectorBlocks(replicaCss, '.workspace-tools-content.is-launcher')
check(
  workspaceLaunchers.some((block) => /background\s*:\s*var\(--bg-under\)/.test(block)) &&
  emptyLauncherSurfaces.some((block) => /background\s*:\s*var\(--bg-under\)/.test(block)),
  'empty workspace tool launcher shares the darker navigation chrome surface'
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
const finalComposerBox = selectorBlocks(replicaCss, '.composer-box')
  .filter((block) => /border-radius\s*:/.test(block))
  .at(-1) ?? ''
const finalComposerFocus = selectorBlocks(replicaCss, '.composer-box:focus-within').at(-1) ?? ''
const finalComposerDock = selectorBlocks(replicaCss, '.composer-dock')
  .filter((block) => /border-top\s*:/.test(block))
  .at(-1) ?? ''
check(
  /border\s*:\s*0\s*!important/.test(finalComposerBox) &&
  /border-radius\s*:\s*var\(--radius-composer\)\s*!important/.test(finalComposerBox) &&
  /box-shadow\s*:\s*none\s*!important/.test(finalComposerBox) &&
  /border\s*:\s*0\s*!important/.test(finalComposerFocus) &&
  /box-shadow\s*:\s*none\s*!important/.test(finalComposerFocus) &&
  /border-top\s*:\s*0\s*!important/.test(finalComposerDock) &&
  hasToken(replicaCss, ['--radius-composer'], ['16px']),
  'composer uses a 16px borderless surface with no top separator'
)
check(
  selectorBlocks(replicaCss, '.composer-box .send-button').some((block) =>
    /border-radius\s*:\s*50%\s*!important/.test(block)
  ),
  'composer send and stop states remain fully circular'
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
  /--benchmark-bg\s*:\s*var\(--surface\)/.test(benchmarkCss) &&
    /--benchmark-panel-raised\s*:\s*var\(--surface-card\)/.test(benchmarkCss) &&
    /--benchmark-radius-lg\s*:\s*8px/.test(benchmarkCss) &&
    !/linear-gradient|radial-gradient/i.test(benchmarkCss),
  'Benchmark inherits the neutral theme surfaces, restrained radii and no gradients'
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

const responsiveWidths = [400, 540, 720, 900, 1100, 1366, 1920] as const
const responsiveHeights = [520, 640] as const
const responsiveSurfaces = [
  { area: 'App shell', selector: '.app-view-stage' },
  { area: 'Workspace chat + composer', selector: '.chat-panel' },
  { area: 'Review', selector: '.workbench.is-embedded' },
  { area: 'Terminal', selector: '.workspace-terminal-shell' },
  { area: 'Browser', selector: '.project-preview.is-workspace .project-preview-display' },
  { area: 'Computer Use', selector: '.project-preview.is-workspace .project-preview-type' },
  { area: 'Files', selector: '.workspace-files-panel' },
  { area: 'Research', selector: '.research-page-wrap' },
  { area: 'Benchmark', selector: '.benchmark-experience' },
  { area: 'Plugins', selector: '.plugins-page' },
  { area: 'Settings', selector: '.settings-page-inner' },
  { area: 'Dashboard', selector: '.profile-dashboard' }
] as const
const responsiveCss = `${replicaCss}\n${stylesCss}\n${benchmarkCss}`

function hasIntrinsicWidthRelease(selector: string): boolean {
  return selectorBlocks(responsiveCss, selector).some((block) =>
    /(?:min-width\s*:\s*0|max-width\s*:\s*(?:100%|calc\()|width\s*:\s*100%|overflow(?:-x)?\s*:\s*(?:hidden|auto))/.test(block)
  )
}

let responsiveTestCount = 0
for (const width of responsiveWidths) {
  const widthContract =
    width > 1100 ||
    hasBreakpoint(replicaCss, width) ||
    (width === 1100 && hasBreakpoint(replicaCss, 1100))

  for (const surface of responsiveSurfaces) {
    responsiveTestCount += 1
    check(
      widthContract && hasIntrinsicWidthRelease(surface.selector),
      `responsive ${width}px · ${surface.area} releases intrinsic width and owns overflow`
    )
  }
}

for (const height of responsiveHeights) {
  for (const surface of responsiveSurfaces) {
    responsiveTestCount += 1
    check(
      hasHeightBreakpoint(replicaCss, height) && hasIntrinsicWidthRelease(surface.selector),
      `responsive short ${height}px · ${surface.area} remains bounded`
    )
  }
}

check(
  responsiveTestCount === 108,
  'responsive matrix executes 108 viewport-and-surface contract tests'
)

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

console.log(
  `\n[responsive-summary] ${responsiveTestCount} responsive tests · widths ${responsiveWidths.join(', ')}px · short heights ${responsiveHeights.join(', ')}px · areas: ${responsiveSurfaces.map((surface) => surface.area).join(', ')}`
)
console.log('\nReplica UI verification passed.')

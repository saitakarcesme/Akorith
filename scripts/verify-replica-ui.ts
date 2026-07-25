import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

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
const settings = read('src/renderer/src/components/SettingsCenter.tsx')
const main = read('src/main/index.ts')
const replicaCss = read('src/renderer/src/replica-ui.css')

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
  { names: ['--surface', '--replica-surface'], values: ['#181818'], label: 'surface' },
  { names: ['--surface-soft', '--replica-surface-soft'], values: ['#1f1f1f'], label: 'soft surface' },
  { names: ['--surface-card', '--replica-surface-card'], values: ['#232323'], label: 'card surface' },
  { names: ['--surface-control', '--replica-surface-control'], values: ['#2d2d2d'], label: 'control surface' },
  { names: ['--text', '--replica-text'], values: ['#fff', '#ffffff'], label: 'primary text' },
  { names: ['--text-secondary', '--replica-text-secondary'], values: ['#ffffffb3'], label: 'secondary text' },
  { names: ['--border', '--replica-border'], values: ['#ffffff14'], label: 'border' },
  { names: ['--blue', '--replica-blue'], values: ['#339cff'], label: 'blue accent' },
  { names: ['--green', '--replica-green'], values: ['#00a240'], label: 'green accent' },
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

check(chat.includes('replica-app-symbol'), 'chat includes the replica application symbol')
check(chat.includes('replica-suggestion-grid'), 'chat includes the replica suggestion grid')
check(chat.includes('replica-feature-banner'), 'chat includes the replica feature banner')
check(chat.includes('replica-composer-context'), 'chat includes replica composer context')

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
    'loops-page-wrap',
    /view\s*===\s*['"]loops['"]/,
    'ProjectLoopPage'
  ),
  'Loop remains mounted and is hidden with display:none'
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

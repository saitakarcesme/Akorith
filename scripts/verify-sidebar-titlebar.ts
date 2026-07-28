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

function block(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 's').exec(css)?.[1] ?? ''
}

const sidebar = read('src/renderer/src/components/Sidebar.tsx')
const css = read('src/renderer/src/replica-ui.css')
const main = read('src/main/index.ts')
const collapsed = block(css, ".app[data-ui='replica'] .project-chats-collapse")
const expanded = block(css, ".app[data-ui='replica'] .project-chats-collapse.is-open")
const children = block(css, ".app[data-ui='replica'] .project-chats-collapse > .project-chats")
const chrome = block(css, ".app[data-ui='replica'] .app-chrome")

check(
  sidebar.includes("className={`project-chats-collapse ${isExpanded ? 'is-open' : ''}`}"),
  'project chat children stay mounted and expose their animated open state'
)
check(sidebar.includes('aria-hidden={!isExpanded}'), 'collapsed chat children are hidden from assistive navigation')
check(/grid-template-rows:\s*0fr/.test(collapsed) && /opacity:\s*0/.test(collapsed), 'collapsed project chats occupy no row and fade out')
check(
  /visibility:\s*hidden/.test(collapsed) && /pointer-events:\s*none/.test(collapsed),
  'collapsed project chats cannot receive hover or pointer input'
)
check(
  /grid-template-rows\s+180ms/.test(collapsed) && /opacity\s+120ms/.test(collapsed),
  'project chat expansion uses short height and opacity transitions'
)
check(
  /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?transition-duration:\s*0\.01ms\s*!important/.test(css),
  'project chat transition inherits the app-wide reduced-motion fallback'
)
check(
  /grid-template-rows:\s*1fr/.test(expanded) &&
    /opacity:\s*1/.test(expanded) &&
    /visibility:\s*visible/.test(expanded) &&
    /pointer-events:\s*auto/.test(expanded),
  'expanded project chats restore layout, visibility, and interaction'
)
check(/min-height:\s*0/.test(children) && /overflow:\s*hidden/.test(children), 'chat child content clips cleanly while collapsing')
check(/background:\s*var\(--bg-under\)/.test(chrome), 'application chrome uses the shared top-bar surface token')
check(
  main.includes("dark: { chrome: '#1b1d20', surface: '#24272b', symbol: '#f3f4f6' }") &&
    main.includes("light: { chrome: '#d8dce1', surface: '#e7e9ec', symbol: '#20242a' }"),
  'native Windows chrome palette matches replica dark and light tokens'
)
check(
  main.includes('window.setBackgroundColor(colors.surface)') &&
    main.includes('window.setTitleBarOverlay({ color: colors.chrome, symbolColor: colors.symbol, height: 36 })'),
  'live theme changes update native window background and caption overlay'
)
check(
  /titleBarOverlay:\s*\{\s*color:\s*initialColors\.chrome,\s*symbolColor:\s*initialColors\.symbol,\s*height:\s*36/s.test(main),
  'initial Windows caption controls use the selected theme palette'
)
check(
  /settings:setTheme[\s\S]*?setTheme\([\s\S]*?applyWindowTheme\(mainWindowRef,\s*nextTheme\)/.test(main),
  'theme IPC refreshes native caption colors without restarting'
)

if (failures.length > 0) {
  console.error(`\nSidebar/titlebar verification failed (${failures.length} checks).`)
  process.exit(1)
}

console.log('\nSidebar/titlebar verification passed (13 checks).')

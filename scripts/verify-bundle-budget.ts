import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

const root = join(__dirname, '..')
const rendererRoot = join(root, 'out', 'renderer')
const failures: string[] = []

function bytes(path: string): number {
  if (!existsSync(path)) {
    failures.push(`missing build artifact: ${path}`)
    return 0
  }
  return statSync(path).size
}

function within(actual: number, limit: number, label: string): void {
  const result = `${(actual / 1024).toFixed(1)} KiB / ${(limit / 1024).toFixed(0)} KiB budget`
  if (actual <= limit) console.log(`[ok] ${label}: ${result}`)
  else {
    failures.push(`${label}: ${result}`)
    console.error(`[fail] ${label}: ${result}`)
  }
}

const htmlPath = join(rendererRoot, 'index.html')
if (!existsSync(htmlPath)) {
  console.error('Production output is missing. Run `npm run build` before this verifier.')
  process.exit(1)
}

const html = readFileSync(htmlPath, 'utf8')
const initialScripts = [...html.matchAll(/<script[^>]+src="\.\/([^"]+)"/g)].map((match) => match[1])
const initialStyles = [...html.matchAll(/<link[^>]+href="\.\/([^"]+\.css)"/g)].map((match) => match[1])
const initialJsBytes = initialScripts.reduce((total, relative) => total + bytes(join(rendererRoot, relative)), 0)
const initialCssBytes = initialStyles.reduce((total, relative) => total + bytes(join(rendererRoot, relative)), 0)

within(initialJsBytes, 500 * 1024, 'initial renderer JavaScript')
within(initialCssBytes, 525 * 1024, 'initial renderer CSS')
within(bytes(join(root, 'out', 'main', 'index.js')), 950 * 1024, 'initial main-process JavaScript')
within(bytes(join(root, 'out', 'preload', 'index.js')), 50 * 1024, 'preload bridge JavaScript')

const eagerNames = [...initialScripts, ...initialStyles].map((path) => basename(path)).join('\n')
for (const deferred of ['ChatMarkdown', 'ChatMessageView', 'SettingsCenter', 'Dashboard', 'Plugins']) {
  if (eagerNames.includes(deferred)) {
    failures.push(`${deferred} was referenced by the initial HTML`)
    console.error(`[fail] ${deferred} was referenced by the initial HTML`)
  } else {
    console.log(`[ok] ${deferred} remains deferred`)
  }
}

const emittedNames = readdirSync(rendererRoot, { recursive: true }).map(String)
if (emittedNames.some((path) => path.includes('ProjectLoopPage'))) {
  failures.push('removed standalone ProjectLoopPage was emitted')
  console.error('[fail] removed standalone ProjectLoopPage was emitted')
} else {
  console.log('[ok] removed standalone ProjectLoopPage is absent from production output')
}

console.log(`[measure] initial assets: ${(initialJsBytes / 1024).toFixed(1)} KiB JS + ${(initialCssBytes / 1024).toFixed(1)} KiB CSS`)

if (failures.length > 0) {
  console.error(`\nBundle budget failed (${failures.length} finding${failures.length === 1 ? '' : 's'}).`)
  process.exit(1)
}

console.log('\nBundle budget passed.')

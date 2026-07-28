import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const component = readFileSync(resolve(root, 'src/renderer/src/components/Plugins.tsx'), 'utf8')
const styles = readFileSync(resolve(root, 'src/renderer/src/styles.css'), 'utf8')

let checks = 0
function verify(condition: unknown, message: string): void {
  assert.ok(condition, message)
  checks += 1
}

const categories = [
  'Agents & workflow',
  'Project & source control',
  'Runtimes & data',
  'Documents & media',
  'Memory & browser',
  'Quality & diagrams'
]
verify(categories.every((label) => component.includes(`label: '${label}'`)), 'all six meaningful plugin categories must be declared')

const categorizedIds = [
  'opencode-agent', 'testlab-extensions', 'mission-runners', 'controller-api',
  'github-workbench', 'git-cli', 'git-lfs-tool', 'ripgrep-tool',
  'remote-ollama-telemetry', 'python-runtime', 'node-runtime', 'jq-tool', 'sqlite-tool',
  'hermes-memory', 'chroma-memory', 'browser-automation',
  'ffmpeg-tool', 'pandoc-tool', 'poppler-tool', 'imagemagick-tool', 'tesseract-tool', 'yt-dlp-tool',
  'shellcheck-tool', 'graphviz-tool'
]
verify(categorizedIds.every((id) => component.includes(`'${id}':`)), 'all 24 built-in plugins must have an explicit category')
verify(component.includes('CATEGORY_BY_KIND[plugin.kind]'), 'future plugins must receive a category through their kind')

verify(component.includes('className="plugin-category-grid"'), 'categorized plugin grid must render')
verify(component.includes('className="plugin-category-header"'), 'each category must render its own heading and count')
verify(
  styles.includes('grid-template-columns: repeat(2, minmax(0, 1fr));'),
  'desktop plugin layout must use two real content columns'
)
verify(
  /@media \(max-width: 760px\)[\s\S]*?\.plugin-category-grid \{\s*grid-template-columns: minmax\(0, 1fr\);/.test(styles),
  'narrow plugin layout must collapse to one content column'
)

verify(
  component.includes('plugins-tabs research-surface-switch'),
  'plugin source tabs must reuse the Research surface-switch design language'
)
verify(
  component.includes('onKeyDown={handleTabKeyDown}') && component.includes("['ArrowLeft', 'ArrowRight', 'Home', 'End']"),
  'plugin tabs must support the same keyboard navigation pattern'
)
verify(
  component.includes('window.api.plugins.disable(plugin.id)') &&
    component.includes('window.api.plugins.enable(plugin.id)') &&
    component.includes('type="checkbox" checked={plugin.enabled}'),
  'existing plugin enable/disable behavior must remain wired'
)

console.log(`verify-plugins-ui: ok (${checks}/${checks})`)

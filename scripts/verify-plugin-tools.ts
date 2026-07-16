import assert from 'node:assert/strict'
import { BUILTIN_PLUGINS } from '../src/main/plugins/builtin'
import { checkCommand } from '../src/main/plugins/diagnostics'

const expected = [
  'git-cli',
  'ripgrep-tool',
  'jq-tool',
  'sqlite-tool',
  'ffmpeg-tool',
  'pandoc-tool',
  'poppler-tool',
  'imagemagick-tool',
  'tesseract-tool',
  'graphviz-tool',
  'python-runtime',
  'node-runtime',
  'git-lfs-tool',
  'shellcheck-tool',
  'yt-dlp-tool'
]

const manifests = BUILTIN_PLUGINS.filter((plugin) => expected.includes(plugin.id))
assert.equal(manifests.length, expected.length, 'all 15 audited local tool manifests must exist')
assert.equal(new Set(manifests.map((plugin) => plugin.id)).size, expected.length, 'plugin ids must be unique')

for (const plugin of manifests) {
  assert.ok(plugin.diagnosticCommand, `${plugin.id} must have a bounded diagnostic command`)
  assert.ok(plugin.capabilityHint, `${plugin.id} must have an audited capability hint`)
  assert.ok(plugin.installHint, `${plugin.id} must have opt-in installation guidance`)
  assert.ok(plugin.docsUrl?.startsWith('https://'), `${plugin.id} must link to primary documentation`)
  assert.match(plugin.diagnosticCommand!.command, /^[a-z0-9-]+$/i, `${plugin.id} diagnostic must be a plain executable`)
  assert.ok(plugin.diagnosticCommand!.args.every((arg) => !/[;&|`$]/.test(arg)), `${plugin.id} diagnostic args must not contain shell syntax`)
}

async function main(): Promise<void> {
  const diagnostics = await Promise.all(manifests.map(async (plugin) => ({
    id: plugin.id,
    result: await checkCommand(plugin.diagnosticCommand!.command, plugin.diagnosticCommand!.args)
  })))
  const available = diagnostics.filter((item) => item.result.available)
  const unavailable = diagnostics.filter((item) => !item.result.available)

  console.log(`verify-plugin-tools: ok (${available.length} ready, ${unavailable.length} unavailable on this machine)`)
  if (available.length) console.log(`ready: ${available.map((item) => item.id).join(', ')}`)
  if (unavailable.length) console.log(`unavailable: ${unavailable.map((item) => item.id).join(', ')}`)
}

void main()

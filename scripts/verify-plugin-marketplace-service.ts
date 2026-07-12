import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginMarketplaceService } from '../src/main/plugin-marketplace/service'

let checks = 0
const check = (condition: unknown, message: string): void => {
  assert.ok(condition, message)
  checks += 1
}

const root = mkdtempSync(join(tmpdir(), 'akorith-marketplace-'))
const path = join(root, 'marketplace.json')
let now = 1_800_000_000_000

try {
  const service = new PluginMarketplaceService(path, () => now++)
  const catalog = service.list()
  check(catalog.length === 30, 'the production catalog exposes exactly 30 integrations')
  check(catalog.every((plugin) => plugin.installation.state === 'not-installed'), 'fresh plugins start uninstalled')
  check(catalog.every((plugin) => plugin.connection.state === 'not-installed'), 'fresh plugins are never reported connected')

  const id = 'github'
  service.install(id)
  check(service.list().find((plugin) => plugin.manifest.id === id)?.installation.state === 'installed', 'install completes')
  service.enable(id)
  const enabled = service.list().find((plugin) => plugin.manifest.id === id)
  check(enabled?.installation.state === 'enabled', 'enable completes')
  check(enabled?.connection.state === 'disconnected', 'enable does not fabricate a connection')

  service.check(id)
  const checked = service.list().find((plugin) => plugin.manifest.id === id)
  check(checked?.connection.state === 'disconnected', 'an unconfigured health check stays disconnected')
  check(Boolean(checked?.connection.checkedAt), 'health evidence records its observation time')

  const restarted = new PluginMarketplaceService(path, () => now++)
  check(restarted.list().find((plugin) => plugin.manifest.id === id)?.installation.state === 'enabled', 'lifecycle survives restart')
  const persisted = readFileSync(path, 'utf8')
  check(!/token|password|secret/i.test(persisted), 'state contains no credential material')

  restarted.disable(id)
  check(restarted.list().find((plugin) => plugin.manifest.id === id)?.installation.state === 'disabled', 'disable completes')
  restarted.uninstall(id)
  check(restarted.list().find((plugin) => plugin.manifest.id === id)?.installation.state === 'not-installed', 'uninstall completes')

  assert.throws(() => restarted.install('../unknown'), /Unknown marketplace plugin/)
  checks += 1
  console.log(`Plugin marketplace service verification passed (${checks} checks).`)
} finally {
  rmSync(root, { recursive: true, force: true })
}

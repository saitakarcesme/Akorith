import assert from 'node:assert/strict'
import {
  MARKETPLACE_PLUGINS,
  REQUIRED_PLUGIN_NAMES,
  SafeStorageCredentialVault,
  InMemoryCredentialVault,
  InMemoryEncryptedCredentialStore,
  assertLifecycleContract,
  assertMarketplaceCatalogContract,
  exerciseCredentialVaultContract,
  installAndEnableForContract,
  permissionGrantsFor,
  resolvePluginConnection,
  validatePluginManifest,
  verifiedHealthReport,
  beginLifecycleTransition,
  completeLifecycleTransition,
  createPluginInstallation,
  type SafeStorageAdapter
} from '../src/main/plugin-marketplace/index.ts'

let failures = 0

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures++
    console.log(`  FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const github = MARKETPLACE_PLUGINS.find((plugin) => plugin.id === 'github')
if (!github) throw new Error('GitHub manifest fixture is missing.')

async function main(): Promise<void> {
  await check('catalog contains exactly the required 30 plugins', () => {
    assertMarketplaceCatalogContract()
    assert.deepEqual(MARKETPLACE_PLUGINS.map((plugin) => plugin.name), [...REQUIRED_PLUGIN_NAMES])
  })

  await check('all manifests expose every contribution and policy surface', () => {
    for (const manifest of MARKETPLACE_PLUGINS) {
      assert.match(manifest.version, /^\d+\.\d+\.\d+/)
      assert.ok(manifest.publisher.name)
      assert.ok(manifest.category)
      assert.ok(manifest.description)
      assert.ok(manifest.icon.fallback)
      assert.ok(manifest.capabilities.length)
      assert.ok(manifest.skills.length)
      assert.ok(manifest.mcpServers.length)
      assert.ok(manifest.hooks.length)
      assert.ok(manifest.apps.length)
      assert.ok(manifest.commands.length)
      assert.ok(manifest.permissions.length)
      assert.equal(manifest.configSchema.additionalProperties, false)
      assert.equal(manifest.health.initialState, 'disconnected')
    }
  })

  await check('manifest validation rejects plaintext credential config', () => {
    const invalid = structuredClone(github)
    invalid.configSchema.fields.credentialRef = {
      type: 'string',
      title: 'Token',
      description: 'An unsafe plaintext token field.',
      required: true
    }
    const result = validatePluginManifest(invalid)
    assert.equal(result.ok, false)
    if (!result.ok) assert.ok(result.issues.some((issue) => issue.message.includes('credential reference')))
  })

  await check('manifest validation rejects wildcard permission scopes', () => {
    const invalid = structuredClone(github)
    invalid.permissions[0].scopes = ['*']
    const result = validatePluginManifest(invalid)
    assert.equal(result.ok, false)
    if (!result.ok) assert.ok(result.issues.some((issue) => issue.message.includes('wildcard')))
  })

  await check('lifecycle covers install, enable, update, disable, failure recovery, and uninstall', () => {
    assertLifecycleContract(github)
  })

  await check('lifecycle rejects illegal and non-incrementing transitions', () => {
    const empty = createPluginInstallation(github.id, 0)
    assert.throws(() => beginLifecycleTransition(empty, github, 'enable'), /Cannot enable/)
    let installed = beginLifecycleTransition(empty, github, 'install', { now: 1 })
    installed = completeLifecycleTransition(installed, 2)
    assert.throws(
      () => beginLifecycleTransition(installed, github, 'update'),
      /must be newer/
    )
    assert.throws(
      () => beginLifecycleTransition(installed, github, 'enable', { permissionGrants: [] }),
      /Required permissions/
    )
    assert.doesNotThrow(() =>
      beginLifecycleTransition(installed, github, 'enable', { permissionGrants: permissionGrantsFor(github) })
    )
  })

  await check('credential plugins never fake a connected state', () => {
    const enabled = installAndEnableForContract(github)
    const healthy = verifiedHealthReport(github, { checkedAt: 10 })
    assert.equal(
      resolvePluginConnection({ manifest: github, installation: enabled, credentialsPresent: false, health: healthy, now: 10 }).state,
      'disconnected'
    )
    assert.equal(
      resolvePluginConnection({
        manifest: github,
        installation: enabled,
        credentialsPresent: true,
        health: { ...healthy, verified: false },
        now: 10
      }).state,
      'disconnected'
    )
    assert.equal(
      resolvePluginConnection({
        manifest: github,
        installation: enabled,
        credentialsPresent: true,
        health: { ...healthy, authenticated: false },
        now: 10
      }).state,
      'disconnected'
    )
    assert.equal(
      resolvePluginConnection({ manifest: github, installation: enabled, credentialsPresent: true, health: healthy, now: 10 }).state,
      'connected'
    )
    assert.equal(
      resolvePluginConnection({
        manifest: github,
        installation: enabled,
        credentialsPresent: true,
        health: { ...healthy, status: 'degraded' },
        now: 10
      }).state,
      'degraded'
    )
    assert.equal(
      resolvePluginConnection({
        manifest: github,
        installation: enabled,
        credentialsPresent: true,
        health: { ...healthy, checkedAt: 1 },
        now: github.health.staleAfterMs + 2
      }).state,
      'disconnected'
    )
  })

  await check('in-memory credential adapter satisfies the no-get vault contract', async () => {
    const vault = new InMemoryCredentialVault(() => 42)
    assert.equal('get' in vault, false)
    await exerciseCredentialVaultContract(vault)
    vault.clear()
  })

  await check('safeStorage seam stores ciphertext and satisfies the vault contract', async () => {
    const safeStorage: SafeStorageAdapter = {
      isEncryptionAvailable: () => true,
      encryptString: (plaintext) => Buffer.from(plaintext, 'utf8').map((value) => value ^ 0x5a),
      decryptString: (encrypted) => Buffer.from(encrypted).map((value) => value ^ 0x5a).toString('utf8')
    }
    const store = new InMemoryEncryptedCredentialStore()
    const vault = new SafeStorageCredentialVault(safeStorage, store, () => 84)
    await exerciseCredentialVaultContract(vault)

    await vault.put({ id: 'cipher-check', pluginId: 'github', label: 'Cipher check', secret: 'visible-secret' })
    const stored = await store.readEncrypted('cipher-check')
    assert.ok(stored)
    assert.equal(Buffer.from(stored.ciphertext).toString('utf8').includes('visible-secret'), false)
    await vault.delete('cipher-check')
  })

  await check('safeStorage seam fails closed when OS encryption is unavailable', async () => {
    const unavailable: SafeStorageAdapter = {
      isEncryptionAvailable: () => false,
      encryptString: () => {
        throw new Error('must not encrypt')
      },
      decryptString: () => {
        throw new Error('must not decrypt')
      }
    }
    const vault = new SafeStorageCredentialVault(unavailable, new InMemoryEncryptedCredentialStore())
    await assert.rejects(
      vault.put({ id: 'blocked', pluginId: 'github', label: 'Blocked', secret: 'secret' }),
      /encryption is unavailable/
    )
  })

  if (failures > 0) {
    console.error(`\nverify-plugin-marketplace: ${failures} failed`)
    process.exit(1)
  }
  console.log('\nverify-plugin-marketplace: ok')
}

void main()

import assert from 'node:assert/strict'
import { createControllerServer } from '../src/main/controller/server.ts'

// Phase 35: boots the controller on an ephemeral loopback port with stub settings
// and stub read-only data, then checks auth + a couple of read endpoints, and shuts
// down. No electron, no config, no network exposure beyond 127.0.0.1.

interface Settings {
  enabled: boolean
  host: string
  port: number
  token: string
  allowLan: boolean
  readOnly: boolean
  sseEnabled: boolean
  lastStartedAt?: number
  lastError?: string
}

async function tryPort(port: number): Promise<boolean> {
  const settings: Settings = {
    enabled: true,
    host: '127.0.0.1',
    port,
    token: '',
    allowLan: false,
    readOnly: true,
    sseEnabled: true
  }
  const server = createControllerServer({
    version: '0.0.0-test',
    getSettings: () => settings,
    saveSettings: (patch) => Object.assign(settings, patch),
    data: {
      agents: () => [{ id: 'codex' }],
      runtime: () => ({ observedSessions: [] }),
      projects: () => [{ id: 'p1', name: 'demo' }],
      chats: () => [{ id: 'c1', title: 'hello' }],
      missions: () => [],
      plugins: () => [{ id: 'opencode-agent', status: 'unavailable' }],
      gpu: () => ({ status: 'unavailable' }),
      ollama: () => ({ configuredBaseUrl: 'http://localhost:11434', endpointKind: 'local' })
    }
  })

  const started = await server.start()
  if (!started.ok) {
    await server.stop()
    return false
  }

  const base = `http://127.0.0.1:${port}`
  const token = settings.token
  assert.ok(token.startsWith('ak_'), 'a token is generated on start')

  // /health needs no auth.
  const health = await fetch(`${base}/health`)
  assert.equal(health.status, 200, 'health is 200')
  const healthBody = (await health.json()) as { ok: boolean; app: string }
  assert.equal(healthBody.ok, true, 'health ok')
  assert.equal(healthBody.app, 'Akorith', 'health app name')

  // Protected endpoint without token → 401.
  const noAuth = await fetch(`${base}/v1/status`)
  assert.equal(noAuth.status, 401, 'protected endpoint rejects missing token')

  // Wrong token → 401.
  const badAuth = await fetch(`${base}/v1/status`, { headers: { Authorization: 'Bearer wrong' } })
  assert.equal(badAuth.status, 401, 'protected endpoint rejects wrong token')

  // Correct token → 200.
  const ok = await fetch(`${base}/v1/status`, { headers: { Authorization: `Bearer ${token}` } })
  assert.equal(ok.status, 200, 'valid token authorizes')
  const statusBody = (await ok.json()) as { app: string; summary: { projects: number } }
  assert.equal(statusBody.app, 'Akorith', 'status app name')
  assert.equal(statusBody.summary.projects, 1, 'status summary counts stub projects')

  // Plugins endpoint returns the stub registry.
  const plugins = await fetch(`${base}/v1/plugins`, { headers: { Authorization: `Bearer ${token}` } })
  assert.equal(plugins.status, 200, 'plugins endpoint authorizes')
  const pluginBody = (await plugins.json()) as unknown[]
  assert.ok(Array.isArray(pluginBody) && pluginBody.length === 1, 'plugins list returned')

  // Unknown path → 404.
  const missing = await fetch(`${base}/v1/nope`, { headers: { Authorization: `Bearer ${token}` } })
  assert.equal(missing.status, 404, 'unknown path is 404')

  await server.stop()
  assert.equal(server.isRunning(), false, 'server stops cleanly')
  return true
}

async function main(): Promise<void> {
  // Try a few high loopback ports in case one is busy on the dev machine.
  for (const port of [47931, 47941, 47951, 47961]) {
    if (await tryPort(port)) {
      console.log('verify-controller: ok')
      return
    }
  }
  throw new Error('could not bind any test port on 127.0.0.1')
}

void main().catch((err) => {
  console.error('verify-controller: FAILED')
  console.error(err)
  process.exit(1)
})

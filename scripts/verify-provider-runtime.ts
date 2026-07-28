import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  isCliTimeoutError,
  runCli,
  type RunCliDiagnostic
} from '../src/main/providers/util.ts'
import { boundedCommandOutput } from '../src/main/providers/chatgpt.ts'

const fixture = fileURLToPath(new URL('./fixtures/provider-runtime-child.cjs', import.meta.url))

async function main(): Promise<void> {
  const sanitized = boundedCommandOutput(`\u001b[32mok\u001b[0m\nAuthorization: secret-value\n${'x'.repeat(600)}`)
  assert.ok(sanitized)
  assert.ok(!sanitized.includes('\u001b'))
  assert.ok(!sanitized.includes('secret-value'))
  assert.ok(sanitized.length <= 480)

  const stalledDiagnostics: RunCliDiagnostic[] = []

  await assert.rejects(
    runCli('node', [fixture, 'stall'], {
      timeoutMs: 2_000,
      inactivityWarningMs: 150,
      inactivityTimeoutMs: 300,
      onDiagnostic: (diagnostic) => stalledDiagnostics.push(diagnostic)
    }),
    (error: unknown) => {
      assert.ok(isCliTimeoutError(error))
      assert.equal(error.timeoutKind, 'inactivity')
      assert.equal(error.thresholdMs, 300)
      return true
    }
  )
  assert.ok(
    stalledDiagnostics.some((diagnostic) => diagnostic.kind === 'inactive'),
    'a silent live process must emit an inactivity warning before termination'
  )
  assert.ok(
    stalledDiagnostics.some((diagnostic) => diagnostic.kind === 'timed_out'),
    'a silent live process must emit a typed timeout diagnostic'
  )
  for (const diagnostic of stalledDiagnostics) {
    const keys = Object.keys(diagnostic)
    assert.ok(!keys.includes('args'))
    assert.ok(!keys.includes('stdin'))
    assert.ok(!keys.includes('cwd'))
    assert.ok(!keys.includes('stdout'))
    assert.ok(!keys.includes('stderr'))
  }

  const healthyDiagnostics: RunCliDiagnostic[] = []
  const healthy = await runCli('node', [fixture, 'pulse'], {
    timeoutMs: 1_000,
    inactivityWarningMs: 200,
    inactivityTimeoutMs: 300,
    onDiagnostic: (diagnostic) => healthyDiagnostics.push(diagnostic)
  })
  assert.equal(healthy.code, 0)
  assert.match(healthy.stdout, /pulse-5/)
  assert.ok(
    !healthyDiagnostics.some((diagnostic) => diagnostic.kind === 'inactive' || diagnostic.kind === 'timed_out'),
    'regular output must reset both inactivity timers'
  )
  assert.ok(
    healthyDiagnostics.some((diagnostic) => diagnostic.kind === 'exited'),
    'a clean process exit must be observable'
  )

  const resumedDiagnostics: RunCliDiagnostic[] = []
  const resumed = await runCli('node', [fixture, 'resume'], {
    timeoutMs: 1_500,
    inactivityWarningMs: 120,
    inactivityTimeoutMs: 700,
    onDiagnostic: (diagnostic) => resumedDiagnostics.push(diagnostic)
  })
  assert.equal(resumed.code, 0)
  assert.ok(resumedDiagnostics.some((diagnostic) => diagnostic.kind === 'inactive'))
  assert.ok(
    resumedDiagnostics.some((diagnostic) => diagnostic.kind === 'activity'),
    'output after an inactivity warning must emit a recovery diagnostic'
  )

  const registrySource = readFileSync(new URL('../src/main/providers/registry.ts', import.meta.url), 'utf8')
  assert.ok(
    (registrySource.match(/activities:\s*requestActivities/g) ?? []).length >= 2,
    'completed and failed turns must both persist normalized activity metadata'
  )
  assert.match(
    registrySource,
    /If the selected directory is empty, scaffold or create the requested project/,
    'Workspace execute mode must treat an empty directory as a scaffold target'
  )
  assert.match(
    registrySource,
    /requestTimedOut \|\| providerTimedOut[\s\S]*?'timed_out'/,
    'provider watchdog errors must become the durable timed_out lifecycle'
  )

  console.log('verify-provider-runtime: ok')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

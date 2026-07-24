import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { closeDb, initDb } from '../src/main/db.ts'
import { describeProviders } from '../src/main/providers/registry.ts'
import { runResearchCycle } from '../src/main/research/runner.ts'
import {
  acquireResearchLease,
  releaseResearchLease,
  updateResearchJob
} from '../src/main/research/store/index.ts'
import {
  createManagedResearchJob,
  getResearchJobDetail
} from '../src/main/research/service.ts'
import { pauseScheduledResearchJob } from '../src/main/research/scheduler.ts'

type SmokeProvider = 'opencode' | 'claude'

interface SmokeOptions {
  providers: SmokeProvider[]
  persist: boolean
  checkOnly: boolean
  continuous: boolean
  timeoutMs: number
}

interface SmokeResult {
  providerId: SmokeProvider
  model: string
  mode: 'quick' | 'continuous'
  jobId: string
  status: string
  phase: string
  cycles: number
  sources: number
  claims: number
  artifacts: Array<{ id: string; format: string; version: number; path: string }>
  elapsedMs: number
}

const options = parseOptions(process.argv.slice(2))
app.setName('Akorith')
const isolatedUserData = options.persist ? null : mkdtempSync(join(tmpdir(), 'akorith-research-live-'))
if (isolatedUserData) {
  app.setPath('userData', isolatedUserData)
} else {
  app.setPath('userData', join(app.getPath('appData'), 'Akorith'))
}

async function main(): Promise<void> {
  await app.whenReady()
  const checkoutBefore = checkoutFingerprint(process.cwd())
  try {
    initDb()
    const availability = await describeProviders()
    const selected = options.providers.map((providerId) => {
      const provider = availability.find((candidate) => candidate.id === providerId)
      return {
        providerId,
        available: provider?.available.ok === true,
        reason: provider?.available.reason,
        discoveredModels: provider?.models.length ?? 0
      }
    })

    if (options.checkOnly) {
      printResult({ mode: options.persist ? 'persistent-check' : 'isolated-check', userData: app.getPath('userData'), providers: selected })
      return
    }
    for (const provider of selected) {
      assert.equal(provider.available, true, `${provider.providerId} is unavailable: ${provider.reason ?? 'provider not found'}`)
    }

    const results: SmokeResult[] = []
    for (const providerId of options.providers) results.push(await runQuickSmoke(providerId))
    if (options.continuous) results.push(await runContinuousSmoke(options.providers[0]))
    assert.equal(
      checkoutFingerprint(process.cwd()),
      checkoutBefore,
      'Research provider escaped its managed workspace and changed the launch checkout'
    )
    printResult({
      mode: options.persist ? 'persistent-live' : 'isolated-live',
      userData: app.getPath('userData'),
      retainedInLibrary: options.persist,
      launchCheckoutUnchanged: true,
      results
    })
  } finally {
    closeDb()
    if (isolatedUserData) rmSync(isolatedUserData, { recursive: true, force: true })
    app.quit()
  }
}

async function runQuickSmoke(providerId: SmokeProvider): Promise<SmokeResult> {
  const startedAt = Date.now()
  const model = providerId === 'opencode' ? 'opencode/deepseek-v4-flash-free' : undefined
  const job = createManagedResearchJob({
    title: `Live ${providerId} Research smoke`,
    prompt: 'Using current public sources, identify the official Node.js LTS release line and summarize two practical upgrade considerations. Produce a compact cited report and disclose any inaccessible evidence.',
    providerId,
    model,
    depth: 'quick',
    outputFormat: 'md',
    autoStart: false
  })
  updateResearchJob(job.id, {
    status: 'planning',
    phase: 'understand',
    targetDurationMs: 0,
    maxCycles: 1,
    sourceTarget: 1,
    startedAt,
    nextRunAt: undefined
  })

  return withLeaseAndTimeout(job.id, async (signal) => {
    const cycle = await runResearchCycle(job.id, signal)
    if (!cycle.ok) throw new Error(cycle.error ?? `${providerId} quick Research cycle failed`)
    const detail = getResearchJobDetail(job.id)
    assert.equal(detail.job.status, 'completed', 'one-cycle smoke override must reach a final validated report')
    assert.ok(detail.artifacts.some((artifact) => artifact.status === 'ready'), 'quick live smoke must publish a ready artifact')
    return summarize(providerId, model ?? 'default', 'quick', detail, startedAt)
  })
}

async function runContinuousSmoke(providerId: SmokeProvider): Promise<SmokeResult> {
  const startedAt = Date.now()
  const model = providerId === 'opencode' ? 'opencode/deepseek-v4-flash-free' : undefined
  const job = createManagedResearchJob({
    title: `Live ${providerId} continuous Research smoke`,
    prompt: 'Monitor the official Node.js release page for current LTS information, record one evidence cycle, and keep the investigation open for later updates.',
    providerId,
    model,
    depth: 'continuous',
    outputFormat: 'md',
    autoStart: false
  })
  updateResearchJob(job.id, {
    status: 'planning',
    phase: 'understand',
    startedAt,
    nextRunAt: undefined
  })

  return withLeaseAndTimeout(job.id, async (signal) => {
    const cycle = await runResearchCycle(job.id, signal)
    if (!cycle.ok) throw new Error(cycle.error ?? `${providerId} continuous Research cycle failed`)
    const paused = pauseScheduledResearchJob(job.id)
    assert.equal(paused?.status, 'paused', 'continuous smoke must pause cleanly after its first cycle')
    const detail = getResearchJobDetail(job.id)
    assert.ok(detail.cycles.length >= 1, 'continuous smoke must persist at least one cycle')
    assert.equal(detail.job.status, 'paused')
    return summarize(providerId, model ?? 'default', 'continuous', detail, startedAt)
  })
}

async function withLeaseAndTimeout<T>(jobId: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const owner = `research-live-smoke-${process.pid}`
  assert.equal(acquireResearchLease(jobId, owner, options.timeoutMs + 60_000), true, 'smoke harness must own its job lease')
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error(`Research live smoke exceeded ${Math.round(options.timeoutMs / 60_000)} minutes.`)),
    options.timeoutMs
  )
  timer.unref()
  try {
    return await work(controller.signal)
  } finally {
    clearTimeout(timer)
    releaseResearchLease(jobId, owner)
  }
}

function summarize(
  providerId: SmokeProvider,
  model: string,
  mode: SmokeResult['mode'],
  detail: ReturnType<typeof getResearchJobDetail>,
  startedAt: number
): SmokeResult {
  return {
    providerId,
    model,
    mode,
    jobId: detail.job.id,
    status: detail.job.status,
    phase: detail.job.phase,
    cycles: detail.cycles.length,
    sources: detail.sources.length,
    claims: detail.claims.length,
    artifacts: detail.artifacts.map((artifact) => ({
      id: artifact.id,
      format: artifact.format,
      version: artifact.version,
      path: artifact.path
    })),
    elapsedMs: Date.now() - startedAt
  }
}

function parseOptions(args: string[]): SmokeOptions {
  if (args.includes('--help')) {
    console.log('Usage: electron scripts/research-live-smoke-main.cjs [--provider all|opencode|claude] [--continuous] [--check] [--persist] [--timeout-minutes N]')
    process.exit(0)
  }
  const providerArg = valueAfter(args, '--provider') ?? 'all'
  assert.ok(['all', 'opencode', 'claude'].includes(providerArg), 'invalid --provider (use all, opencode, or claude)')
  const timeoutMinutes = Number(valueAfter(args, '--timeout-minutes') ?? '15')
  assert.ok(Number.isFinite(timeoutMinutes) && timeoutMinutes >= 1 && timeoutMinutes <= 60, '--timeout-minutes must be between 1 and 60')
  return {
    providers: providerArg === 'all' ? ['opencode', 'claude'] : [providerArg as SmokeProvider],
    persist: args.includes('--persist'),
    checkOnly: args.includes('--check'),
    continuous: args.includes('--continuous'),
    timeoutMs: Math.round(timeoutMinutes * 60_000)
  }
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

function printResult(value: unknown): void {
  console.log(`RESEARCH_LIVE_SMOKE_RESULT:${JSON.stringify(value)}`)
}

function checkoutFingerprint(cwd: string): string {
  const hash = createHash('sha256')
  hash.update(readdirSync(cwd).sort().join('\0'))
  try {
    const status = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024
    })
    const diff = execFileSync('git', ['diff', '--binary', 'HEAD', '--'], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024
    })
    hash.update(status)
    hash.update(diff)
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024
    }).split('\0').filter(Boolean)
    for (const path of untracked) {
      try {
        const stats = statSync(join(cwd, path))
        if (!stats.isFile()) continue
        hash.update(path)
        hash.update(readFileSync(join(cwd, path)))
      } catch {
        hash.update(`missing:${path}`)
      }
    }
  } catch {
    // The harness also supports packaged/non-git launches. The top-level entry
    // list still catches the accidental file creation that this guard targets.
  }
  return hash.digest('hex')
}

void main().catch((error) => {
  console.error(error)
  closeDb()
  if (isolatedUserData) rmSync(isolatedUserData, { recursive: true, force: true })
  app.exit(1)
})

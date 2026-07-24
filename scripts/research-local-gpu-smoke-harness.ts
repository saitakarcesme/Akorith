import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import { closeDb, initDb } from '../src/main/db.ts'
import { describeProviders } from '../src/main/providers/registry.ts'
import { runResearchCycle } from '../src/main/research/runner.ts'
import { pauseScheduledResearchJob } from '../src/main/research/scheduler.ts'
import {
  acquireResearchLease,
  releaseResearchLease,
  updateResearchJob
} from '../src/main/research/store/index.ts'
import {
  createManagedResearchJob,
  getResearchJobDetail
} from '../src/main/research/service.ts'
import type { ResearchPlan } from '../src/main/research/types.ts'

interface SmokeOptions {
  model?: string
  timeoutMs: number
}

interface GpuSample {
  at: number
  gpuIndex: number
  gpuName: string
  utilizationPct: number
  memoryUsedMiB: number
  memoryTotalMiB: number
  powerW: number
  powerLimitW: number
  temperatureC: number
}

interface GpuMetrics {
  gpuIndex: number
  gpuName: string
  samples: number
  overallDurationMs: number
  aboveTenPctDutyPct: number
  busyDutyPct: number
  cycleBusyDutyPct: number
  modelActiveAverageUtilizationPct: number
  modelActiveAveragePowerW: number
  modelActiveAverageMemoryUsedMiB: number
  averageUtilizationPct: number
  medianUtilizationPct: number
  peakUtilizationPct: number
  averagePowerW: number
  medianPowerW: number
  peakPowerW: number
  powerLimitW: number
  averageMemoryUsedMiB: number
  medianMemoryUsedMiB: number
  peakMemoryUsedMiB: number
  peakTemperatureC: number
}

interface CycleWindow {
  cycle: number
  startedAt: number
  endedAt: number
  durationMs: number
  scheduledNextRunAt?: number
  scheduledDelayMs?: number
  sources: number
  claims: number
}

interface OllamaResidentModel {
  name?: string
  model?: string
  size?: number
  size_vram?: number
  expires_at?: string
}

const execFileAsync = promisify(execFile)
const options = parseOptions(process.argv.slice(2))
const isolatedUserData = mkdtempSync(join(tmpdir(), 'akorith-research-gpu-'))

app.setName('Akorith GPU smoke')
app.setPath('userData', isolatedUserData)

async function main(): Promise<void> {
  await app.whenReady()
  const checkoutBefore = checkoutFingerprint(process.cwd())
  const samples: GpuSample[] = []
  let sampling = false
  let sampler: Promise<void> = Promise.resolve()
  let dbReady = false
  let createdJobId: string | undefined
  let resultPayload: Record<string, unknown> | null = null
  let cleanupRemoved = false
  const timeoutController = new AbortController()
  const timeout = setTimeout(
    () => timeoutController.abort(new Error(`Local GPU smoke exceeded ${Math.round(options.timeoutMs / 60_000)} minutes.`)),
    options.timeoutMs
  )
  timeout.unref()

  try {
    initDb()
    dbReady = true
    const local = (await describeProviders()).find((provider) => provider.id === 'local')
    assert.equal(local?.available.ok, true, `Local provider is unavailable: ${local?.available.reason ?? 'not found'}`)
    const model = options.model ?? local?.models[0]
    assert.ok(model, 'No Ollama model is installed. Pass --ollama-model or run `ollama pull <model>`.')
    assert.ok(local?.models.includes(model), `Ollama model is not installed: ${model}`)

    const plan: ResearchPlan = {
      title: 'Local GPU sustained Research smoke',
      thesis: 'Official evidence can identify the current Node.js LTS line and its upgrade implications.',
      deliverable: 'A compact cited evidence record used only for GPU scheduling verification.',
      sections: [{
        id: 'node-lts-evidence',
        title: 'Official Node.js LTS evidence',
        objective: 'Identify the current Node.js LTS release line from official sources and verify two upgrade considerations.',
        queries: [
          'site:nodejs.org Node.js releases LTS official',
          'site:nodejs.org Node.js migration upgrade LTS official'
        ],
        status: 'pending'
      }],
      sourceStrategy: ['Official Node.js documentation', 'Primary release records'],
      verificationCriteria: ['Every claim cites an accessible source URL.']
    }

    const created = createManagedResearchJob({
      title: plan.title,
      prompt: 'Using current official public sources, identify the current Node.js LTS release line and verify two practical upgrade considerations. Keep claims concise, cited, and explicit about inaccessible evidence.',
      providerId: 'local',
      model,
      depth: 'deep',
      outputFormat: 'md',
      autoStart: false
    })
    createdJobId = created.id
    updateResearchJob(created.id, {
      plan,
      status: 'researching',
      phase: 'research',
      targetDurationMs: 12 * 60 * 60_000,
      maxCycles: 72,
      sourceTarget: 20,
      nextRunAt: undefined
    })

    sampling = true
    sampler = sampleGpuUntilStopped(samples, () => sampling)
    const cycleWindows: CycleWindow[] = []
    let firstCycleEndedAt = 0
    let secondCycleStartedAt = 0
    for (let index = 0; index < 2; index += 1) {
      if (index > 0) {
        const dueAt = getResearchJobDetail(created.id).job.nextRunAt
        assert.ok(dueAt, 'first local Deep cycle must schedule a follow-up')
        await waitUntil(dueAt, timeoutController.signal)
      }

      const owner = `research-gpu-smoke-${process.pid}-${index + 1}`
      assert.equal(
        acquireResearchLease(created.id, owner, options.timeoutMs + 60_000),
        true,
        `GPU smoke must acquire lease ${index + 1}`
      )
      const startedAt = Date.now()
      if (index === 1) secondCycleStartedAt = startedAt
      try {
        const result = await runResearchCycle(created.id, timeoutController.signal)
        if (!result.ok) throw new Error(result.error ?? `Local Research cycle ${index + 1} failed`)
      } finally {
        releaseResearchLease(created.id, owner)
      }
      const endedAt = Date.now()
      if (index === 0) firstCycleEndedAt = endedAt
      const detail = getResearchJobDetail(created.id)
      const scheduledNextRunAt = detail.job.nextRunAt
      cycleWindows.push({
        cycle: index + 1,
        startedAt,
        endedAt,
        durationMs: endedAt - startedAt,
        scheduledNextRunAt,
        scheduledDelayMs: scheduledNextRunAt == null ? undefined : scheduledNextRunAt - detail.job.updatedAt,
        sources: detail.sources.length,
        claims: detail.claims.length
      })
    }

    const paused = pauseScheduledResearchJob(created.id)
    assert.equal(paused?.status, 'paused', 'isolated GPU smoke must leave its job paused')
    await wait(1_500, timeoutController.signal)
    const resident = await readOllamaResidentModel(model)
    sampling = false
    await sampler
    clearTimeout(timeout)

    const finalDetail = getResearchJobDetail(created.id)
    const metrics = summarizeGpu(samples, cycleWindows)
    const scheduledDelayMs = cycleWindows[0].scheduledDelayMs
    const actualIdleGapMs = secondCycleStartedAt - firstCycleEndedAt
    const vramOffloadPct = resident?.size && resident.size_vram != null
      ? Math.round((resident.size_vram / resident.size) * 10_000) / 100
      : null

    assert.ok(scheduledDelayMs != null && scheduledDelayMs >= 4_500 && scheduledDelayMs <= 5_500,
      `local Deep follow-up must be scheduled near 5 seconds, observed ${scheduledDelayMs ?? 'missing'} ms`)
    assert.ok(actualIdleGapMs >= 4_500 && actualIdleGapMs <= 7_500,
      `local Deep intercycle idle gap must stay bounded, observed ${actualIdleGapMs} ms`)
    assert.ok(samples.length >= 5, 'GPU sampler must capture enough observations')
    assert.ok(metrics.peakUtilizationPct >= 75, `expected real CUDA load, peak GPU utilization was ${metrics.peakUtilizationPct}%`)
    const expectedInferencePowerW = Math.min(180, metrics.powerLimitW * 0.6)
    assert.ok(metrics.peakPowerW >= expectedInferencePowerW,
      `expected real local inference power of at least ${expectedInferencePowerW} W, peak was ${metrics.peakPowerW} W`)
    assert.ok(metrics.busyDutyPct >= 55, `expected sustained local inference duty, observed ${metrics.busyDutyPct}%`)
    assert.ok(resident, 'Ollama model must remain resident after the second background cycle')
    assert.ok(vramOffloadPct != null && vramOffloadPct >= 99,
      `expected effectively full GPU offload, observed ${vramOffloadPct ?? 'unknown'}%`)
    assert.equal(checkoutFingerprint(process.cwd()), checkoutBefore, 'GPU smoke changed the launch checkout')

    resultPayload = {
      providerId: 'local',
      model,
      isolatedUserData: true,
      job: {
        id: finalDetail.job.id,
        status: finalDetail.job.status,
        cycles: finalDetail.cycles.length,
        sources: finalDetail.sources.length,
        claims: finalDetail.claims.length,
        activeElapsedMs: finalDetail.job.activeElapsedMs
      },
      cadence: {
        configuredCooldownMs: 5_000,
        scheduledDelayMs,
        actualIdleGapMs
      },
      gpu: metrics,
      ollama: {
        resident: true,
        sizeBytes: resident?.size,
        sizeVramBytes: resident?.size_vram,
        vramOffloadPct,
        expiresAt: resident?.expires_at
      },
      cycles: cycleWindows
    }
  } finally {
    sampling = false
    await sampler.catch(() => {})
    clearTimeout(timeout)
    if (dbReady && createdJobId) {
      try {
        const job = getResearchJobDetail(createdJobId).job
        if (job.status !== 'paused' && job.status !== 'completed' && job.status !== 'archived') {
          pauseScheduledResearchJob(createdJobId)
        }
      } catch {
        // Cleanup continues even if the isolated row was never created fully.
      }
    }
    if (dbReady) closeDb()
    rmSync(isolatedUserData, { recursive: true, force: true })
    cleanupRemoved = !existsSync(isolatedUserData)
  }

  assert.ok(resultPayload, 'GPU smoke produced no result payload')
  assert.equal(cleanupRemoved, true, 'isolated GPU smoke userData was not removed')
  printResult({ ...resultPayload, tempCleanup: { removed: true } })
  app.quit()
}

async function sampleGpuUntilStopped(samples: GpuSample[], running: () => boolean): Promise<void> {
  while (running()) {
    try {
      const { stdout } = await execFileAsync('nvidia-smi', [
        '--query-gpu=index,name,utilization.gpu,memory.used,memory.total,power.draw,power.limit,temperature.gpu',
        '--format=csv,noheader,nounits'
      ], { encoding: 'utf8', timeout: 5_000, windowsHide: true })
      const candidates = String(stdout).trim().split(/\r?\n/).map(parseGpuSample).filter((sample): sample is GpuSample => sample !== null)
      const selected = candidates.sort((left, right) => right.memoryUsedMiB - left.memoryUsedMiB)[0]
      if (selected) samples.push(selected)
    } catch {
      // The final assertions explain a missing/insufficient NVIDIA sample set.
    }
    if (running()) await wait(1_000)
  }
}

function parseGpuSample(line: string): GpuSample | null {
  const parts = line.split(',').map((value) => value.trim())
  if (parts.length < 8) return null
  const numeric = [parts[0], ...parts.slice(2, 8)].map(Number)
  if (!numeric.every(Number.isFinite)) return null
  return {
    at: Date.now(),
    gpuIndex: numeric[0],
    gpuName: parts[1],
    utilizationPct: numeric[1],
    memoryUsedMiB: numeric[2],
    memoryTotalMiB: numeric[3],
    powerW: numeric[4],
    powerLimitW: numeric[5],
    temperatureC: numeric[6]
  }
}

function summarizeGpu(samples: GpuSample[], windows: CycleWindow[]): GpuMetrics {
  const insideCycles = samples.filter((sample) => windows.some((window) => sample.at >= window.startedAt && sample.at <= window.endedAt))
  const busy = samples.filter((sample) => sample.utilizationPct >= 70 || sample.powerW >= 150)
  const active = samples.filter((sample) => sample.powerW >= 150)
  const primary = [...samples].sort((left, right) => right.memoryUsedMiB - left.memoryUsedMiB)[0]
  const values = (key: 'utilizationPct' | 'powerW' | 'powerLimitW' | 'memoryUsedMiB' | 'temperatureC'): number[] =>
    samples.map((sample) => sample[key])
  return {
    gpuIndex: primary?.gpuIndex ?? -1,
    gpuName: primary?.gpuName ?? 'unknown',
    samples: samples.length,
    overallDurationMs: samples.length > 1 ? samples.at(-1)!.at - samples[0].at : 0,
    aboveTenPctDutyPct: roundPct(samples.filter((sample) => sample.utilizationPct > 10).length, samples.length),
    busyDutyPct: roundPct(busy.length, samples.length),
    cycleBusyDutyPct: roundPct(
      insideCycles.filter((sample) => sample.utilizationPct >= 70 || sample.powerW >= 150).length,
      insideCycles.length
    ),
    modelActiveAverageUtilizationPct: roundAverage(active.map((sample) => sample.utilizationPct)),
    modelActiveAveragePowerW: roundAverage(active.map((sample) => sample.powerW)),
    modelActiveAverageMemoryUsedMiB: roundAverage(active.map((sample) => sample.memoryUsedMiB)),
    averageUtilizationPct: roundAverage(values('utilizationPct')),
    medianUtilizationPct: percentile(values('utilizationPct'), 0.5),
    peakUtilizationPct: Math.max(0, ...values('utilizationPct')),
    averagePowerW: roundAverage(values('powerW')),
    medianPowerW: percentile(values('powerW'), 0.5),
    peakPowerW: Math.max(0, ...values('powerW')),
    powerLimitW: percentile(values('powerLimitW'), 0.5),
    averageMemoryUsedMiB: roundAverage(values('memoryUsedMiB')),
    medianMemoryUsedMiB: percentile(values('memoryUsedMiB'), 0.5),
    peakMemoryUsedMiB: Math.max(0, ...values('memoryUsedMiB')),
    peakTemperatureC: Math.max(0, ...values('temperatureC'))
  }
}

async function readOllamaResidentModel(model: string): Promise<OllamaResidentModel | null> {
  const response = await fetch('http://127.0.0.1:11434/api/ps', { signal: AbortSignal.timeout(5_000) })
  if (!response.ok) throw new Error(`Ollama /api/ps failed with HTTP ${response.status}`)
  const body = await response.json() as { models?: OllamaResidentModel[] }
  return (body.models ?? []).find((candidate) => candidate.name === model || candidate.model === model) ?? null
}

async function waitUntil(target: number, signal: AbortSignal): Promise<void> {
  while (Date.now() < target) {
    await wait(Math.min(250, target - Date.now()), signal)
  }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout
    const abort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(signal?.reason)
    }
    const finish = (): void => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }
    timer = setTimeout(finish, Math.max(0, ms))
    timer.unref()
    if (!signal) return
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

function roundPct(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.round((numerator / denominator) * 10_000) / 100 : 0
}

function roundAverage(values: number[]): number {
  return values.length > 0 ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100 : 0
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)))]
}

function parseOptions(args: string[]): SmokeOptions {
  if (args.includes('--help')) {
    console.log('Usage: npm run verify:research-gpu')
    console.log('Optional environment: AKORITH_GPU_SMOKE_MODEL, AKORITH_GPU_SMOKE_TIMEOUT_MINUTES')
    process.exit(0)
  }
  assert.deepEqual(args, [], 'GPU smoke options use environment variables; run with --help for details')
  const timeoutMinutes = Number(process.env.AKORITH_GPU_SMOKE_TIMEOUT_MINUTES ?? '15')
  assert.ok(Number.isFinite(timeoutMinutes) && timeoutMinutes >= 1 && timeoutMinutes <= 60,
    'AKORITH_GPU_SMOKE_TIMEOUT_MINUTES must be between 1 and 60')
  const model = process.env.AKORITH_GPU_SMOKE_MODEL
  assert.ok(model === undefined || /^[\w.:/-]{1,64}$/.test(model), 'invalid AKORITH_GPU_SMOKE_MODEL')
  return { model, timeoutMs: Math.round(timeoutMinutes * 60_000) }
}

function printResult(value: unknown): void {
  console.log(`RESEARCH_LOCAL_GPU_SMOKE_RESULT:${JSON.stringify(value)}`)
}

function checkoutFingerprint(cwd: string): string {
  const hash = createHash('sha256')
  hash.update(readdirSync(cwd).sort().join('\0'))
  try {
    hash.update(execFileSyncText('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd))
    hash.update(execFileSyncText('git', ['diff', '--binary', 'HEAD', '--'], cwd))
    const untracked = execFileSyncText('git', ['ls-files', '--others', '--exclude-standard', '-z'], cwd)
      .split('\0')
      .filter(Boolean)
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
    // Packaged/non-git launches still retain the top-level entry guard.
  }
  return hash.digest('hex')
}

function execFileSyncText(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
}

void main().catch((error: unknown) => {
  console.error(error)
  console.error(`RESEARCH_LOCAL_GPU_SMOKE_ERROR:${JSON.stringify({
    message: error instanceof Error ? error.message : String(error),
    tempCleanupRemoved: !existsSync(isolatedUserData)
  })}`)
  app.exit(1)
})

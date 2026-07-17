import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { closeDb, getDb, initDb, usageDaily, usageSummary } from '../src/main/db.ts'
import { exportResearchJob } from '../src/main/research/exporters/index.ts'
import {
  acquireResearchLease,
  archiveResearchJob,
  cancelInterruptedResearchCycles,
  createResearchJob,
  deleteResearchJob,
  getResearchArtifact,
  getResearchClaim,
  getResearchJob,
  latestResearchCheckpoint,
  linkResearchClaimSource,
  listDueResearchJobs,
  listLatestResearchEvents,
  listResearchArtifacts,
  listResearchClaims,
  listResearchCycles,
  listResearchJobs,
  listResearchSources,
  logResearchEvent,
  recordResearchArtifact,
  recordResearchClaim,
  recordResearchSource,
  releaseExpiredResearchLeases,
  saveResearchCheckpoint,
  startResearchCycle,
  updateResearchJob
} from '../src/main/research/store/index.ts'
import type { ResearchPhase, ResearchStatus, ResearchWorkspaceState } from '../src/main/research/types.ts'
import { recordResearchModelUsage, recordResearchRequest } from '../src/main/research/usage.ts'
import {
  RESEARCH_REPORT_FILE,
  initializeResearchWorkspace,
  safeResearchPath
} from '../src/main/research/workspace.ts'

const isolatedUserData = mkdtempSync(join(tmpdir(), 'akorith-research-persistence-'))
app.setPath('userData', isolatedUserData)

async function main(): Promise<void> {
  await app.whenReady()
  try {
    initDb()
    verifySchema()
    const jobId = seedPersistentLibraryRecord()
    verifyUsageAccounting(jobId)
    verifyPhaseLifecycle(jobId)
    verifySafeSourcePersistence(jobId)
    verifyRestartRoundTrip(jobId)
    verifyCrashRecovery(jobId)
    verifyArchiveFiltering()
    await verifyArtifactVersioning()
    verifyCascadeDeletion()
    console.log('research persistence verifier passed (isolated SQLite lifecycle, recovery, and library round-trip)')
  } finally {
    closeDb()
    rmSync(isolatedUserData, { recursive: true, force: true })
    app.quit()
  }
}

async function verifyArtifactVersioning(): Promise<void> {
  const id = 'research-versioned-artifact-job'
  const workspaceDir = initializeResearchWorkspace(id)
  createResearchJob({
    prompt: 'Publish two independently addressable report revisions.',
    title: 'Versioned artifact fixture',
    providerId: 'opencode',
    model: 'opencode-go/deepseek-v4-flash-free',
    depth: 'quick',
    outputFormat: 'md',
    autoStart: false
  }, workspaceDir, id)
  writeFileSync(
    safeResearchPath(workspaceDir, RESEARCH_REPORT_FILE),
    '# Versioned artifact fixture\n\n## Executive summary\n\nA stable offline revision.\n\n## Findings\n\nThe first and second publications remain addressable.\n\n## Sources\n\nNo external source was required for this packaging check.\n'
  )

  const first = await exportResearchJob(id, 'md')
  const second = await exportResearchJob(id, 'md')
  const rows = listResearchArtifacts(id).sort((left, right) => left.version - right.version)

  assert.equal(first.version, 1)
  assert.equal(second.version, 2)
  assert.notEqual(first.id, second.id, 'each publication must receive a distinct database identity')
  assert.notEqual(first.path, second.path, 'v2 must never overwrite the v1 deliverable')
  assert.equal(existsSync(first.path), true, 'v1 must remain on disk after publishing v2')
  assert.equal(existsSync(second.path), true, 'v2 must be persisted on disk')
  assert.deepEqual(rows.map((artifact) => artifact.version), [1, 2])
  assert.deepEqual(rows.map((artifact) => artifact.path), [first.path, second.path])
  assert.equal(getResearchJob(id)?.artifactPath, second.path, 'library preview must point at the latest publication')
}

function verifySchema(): void {
  const tableNames = new Set(
    (getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'research_%'").all() as Array<{ name: string }>)
      .map((row) => row.name)
  )
  assert.deepEqual(
    [...tableNames].sort(),
    [
      'research_artifacts',
      'research_checkpoints',
      'research_claim_sources',
      'research_claims',
      'research_cycles',
      'research_events',
      'research_jobs',
      'research_sources'
    ],
    'the complete Research library schema must be initialized'
  )
  const usageColumns = new Set(
    (getDb().prepare('PRAGMA table_info(usage_events)').all() as Array<{ name: string }>).map((row) => row.name)
  )
  for (const column of [
    'cache_read_tokens',
    'cache_write_tokens',
    'reasoning_tokens',
    'total_tokens',
    'request_count',
    'source_kind',
    'source_id'
  ]) {
    assert.equal(usageColumns.has(column), true, `usage_events must include ${column}`)
  }
}

function verifyUsageAccounting(jobId: string): void {
  const job = getResearchJob(jobId)!
  const request = getDb().prepare(
    "SELECT request_count, total_tokens FROM usage_events WHERE source_kind = 'research-request' AND source_id = ?"
  ).get(jobId) as { request_count: number; total_tokens: number }
  assert.deepEqual(request, { request_count: 1, total_tokens: 0 }, 'one Research submission is one visible request')
  assert.equal(recordResearchRequest(job), false, 'replaying job creation must not count a second user request')

  assert.equal(recordResearchModelUsage({
    job,
    kind: 'research-plan',
    turnId: job.id,
    model: 'opencode-go/glm-5.2',
    usage: { promptTokens: 15, completionTokens: 25, totalTokens: 40, estimated: false }
  }), true, 'planning usage must enter the shared token ledger')

  const first = recordResearchModelUsage({
    job,
    kind: 'research-cycle',
    turnId: 'usage-fixture-cycle',
    model: 'opencode-go/glm-5.2',
    usage: {
      promptTokens: 10,
      completionTokens: 20,
      cacheReadTokens: 30,
      reasoningTokens: 5,
      // reasoning is a subset of completion for this provider, so the
      // canonical provider total intentionally differs from the component sum.
      totalTokens: 60,
      estimated: false
    }
  })
  const duplicate = recordResearchModelUsage({
    job,
    kind: 'research-cycle',
    turnId: 'usage-fixture-cycle',
    model: 'opencode-go/glm-5.2',
    usage: { promptTokens: 999, completionTokens: 999, totalTokens: 1_998, estimated: false }
  })
  assert.equal(first, true)
  assert.equal(duplicate, false, 'a retried persistence path must not double-count the same Research turn')
  assert.equal(recordResearchModelUsage({
    job,
    kind: 'research-synthesis',
    turnId: `${job.id}:fixture:final`,
    model: 'opencode-go/glm-5.2',
    usage: { promptTokens: 12, completionTokens: 18, totalTokens: 30, estimated: false }
  }), true, 'synthesis usage must enter the shared token ledger')

  const provider = usageSummary().byProvider.find((row) => row.providerId === job.providerId)
  assert.equal(provider?.events, 1, 'internal Research turns must not inflate the user request count')
  assert.equal(provider?.totalTokens, 130, 'plan, cycle, and synthesis totals must be included without double counting subsets')
  assert.equal(provider?.cacheReadTokens, 30)
  assert.equal(provider?.reasoningTokens, 5)
  const today = new Date().toLocaleDateString('en-CA')
  const daily = usageDaily(1).find((row) => row.day === today && row.providerId === job.providerId)
  assert.equal(daily?.events, 1)
  assert.equal(daily?.tokens, 130)

  getDb().prepare(
    `INSERT INTO research_cycles (
       id, job_id, cycle_index, phase, status, objective, source_count, finding_count,
       prompt_tokens, completion_tokens, started_at, ended_at
     ) VALUES (?, ?, ?, 'research', 'completed', 'Legacy usage migration', 0, 0, 7, 8, ?, ?)`
  ).run('legacy-research-usage-cycle', jobId, 999, Date.now() - 1_000, Date.now())
  closeDb()
  initDb()
  const migrated = getDb().prepare(
    "SELECT request_count, total_tokens FROM usage_events WHERE source_kind = 'research-cycle' AND source_id = ?"
  ).get('legacy-research-usage-cycle') as { request_count: number; total_tokens: number }
  assert.deepEqual(migrated, { request_count: 0, total_tokens: 15 }, 'persisted legacy cycle usage must backfill once')
  closeDb()
  initDb()
  const migratedCount = getDb().prepare(
    "SELECT COUNT(*) AS count FROM usage_events WHERE source_kind = 'research-cycle' AND source_id = ?"
  ).get('legacy-research-usage-cycle') as { count: number }
  assert.equal(migratedCount.count, 1, 're-running the historical migration must remain idempotent')
  getDb().prepare('DELETE FROM research_cycles WHERE id = ?').run('legacy-research-usage-cycle')
}

function seedPersistentLibraryRecord(): string {
  const jobId = 'research-persistence-job'
  const workspaceDir = initializeResearchWorkspace(jobId)
  const job = createResearchJob({
    prompt: 'Build an offline evidence-backed persistence fixture.',
    title: 'Persistence fixture',
    providerId: 'opencode',
    model: 'opencode-go/glm-5.2',
    depth: 'quick',
    outputFormat: 'md',
    autoStart: false
  }, workspaceDir, jobId)
  assert.equal(job.status, 'draft')
  assert.equal(job.phase, 'understand')

  logResearchEvent({ jobId, kind: 'created', title: 'Fixture created', detail: 'Offline only' })
  const cycle = startResearchCycle({ jobId, phase: 'research', objective: 'Persist linked evidence' })
  const source = recordResearchSource({
    jobId,
    cycleId: cycle.id,
    url: 'HTTPS://Example.COM/report/?utm_source=test&b=2&a=1#results',
    title: 'Primary persistence source',
    excerpt: 'Stable primary evidence for the persistence fixture.',
    verified: true
  })
  assert.ok(source)
  const claim = recordResearchClaim({
    jobId,
    cycleId: cycle.id,
    sectionId: 'persistence',
    text: 'Research evidence survives an application restart.',
    confidenceScore: 0.95
  })
  linkResearchClaimSource({ claimId: claim.id, sourceId: source.id, relation: 'supports', evidence: 'Round-trip fixture' })

  const state: ResearchWorkspaceState = {
    version: 1,
    jobId,
    cycleCount: 1,
    currentPhase: 'research',
    completedSections: ['persistence'],
    openQuestions: [],
    sourceCount: 1,
    findingCount: 1,
    readyToSynthesize: true,
    updatedAt: Date.now()
  }
  saveResearchCheckpoint({
    jobId,
    cycleId: cycle.id,
    idempotencyKey: 'fixture-research-complete',
    phase: 'research',
    state
  })

  const artifactPath = join(workspaceDir, 'artifacts', 'persistence-fixture.md')
  mkdirSync(join(workspaceDir, 'artifacts'), { recursive: true })
  writeFileSync(artifactPath, '# Persistence fixture\n\n## Executive summary\n\nOffline.\n\n## Sources\n\n1. Example.\n')
  recordResearchArtifact({
    jobId,
    format: 'md',
    title: 'Persistence fixture',
    path: artifactPath,
    validation: {
      ok: true,
      byteSize: 85,
      checksum: 'a'.repeat(64),
      mimeType: 'text/markdown'
    }
  })
  return jobId
}

function verifyPhaseLifecycle(jobId: string): void {
  const lifecycle: Array<{ phase: ResearchPhase; status: ResearchStatus }> = [
    { phase: 'understand', status: 'planning' },
    { phase: 'plan', status: 'planning' },
    { phase: 'research', status: 'researching' },
    { phase: 'verify', status: 'verifying' },
    { phase: 'synthesize', status: 'synthesizing' },
    { phase: 'export', status: 'exporting' }
  ]
  for (const transition of lifecycle) {
    const updated = updateResearchJob(jobId, transition)
    assert.equal(updated?.phase, transition.phase)
    assert.equal(updated?.status, transition.status)
  }
  const completed = updateResearchJob(jobId, {
    phase: 'export',
    status: 'completed',
    summary: 'Persistence lifecycle complete.',
    completedAt: Date.now(),
    nextRunAt: undefined
  })
  assert.equal(completed?.status, 'completed')
  assert.throws(() => updateResearchJob(jobId, { phase: 'invalid' as ResearchPhase }), /invalid research phase/)
  assert.throws(() => updateResearchJob(jobId, { status: 'invalid' as ResearchStatus }), /invalid research status/)
}

function verifySafeSourcePersistence(jobId: string): void {
  assert.equal(recordResearchSource({ jobId, url: 'file:///etc/passwd', title: 'Unsafe local file' }), null)
  assert.equal(recordResearchSource({ jobId, url: 'javascript:alert(1)', title: 'Unsafe script' }), null)

  const canonical = listResearchSources(jobId)[0]
  assert.equal(canonical.url, 'https://example.com/report?a=1&b=2')
  const duplicate = recordResearchSource({
    jobId,
    url: 'https://different.example/evidence',
    title: 'Duplicate body',
    excerpt: ' stable  PRIMARY evidence for the persistence fixture. '
  })
  assert.equal(duplicate?.id, canonical.id, 'normalized duplicate content must resolve to the original source')
  assert.equal(listResearchSources(jobId).length, 1)
}

function verifyRestartRoundTrip(jobId: string): void {
  const before = getResearchJob(jobId)
  const artifactId = listResearchArtifacts(jobId)[0].id
  const claimId = listResearchClaims(jobId)[0].id
  closeDb()
  initDb()

  const after = getResearchJob(jobId)
  assert.deepEqual(after, before, 'job metadata must survive a close/reopen cycle')
  assert.equal(listResearchCycles(jobId).length, 1)
  assert.equal(listLatestResearchEvents(jobId).length, 1)
  assert.equal(listResearchSources(jobId).length, 1)
  assert.equal(getResearchClaim(claimId)?.evidence.length, 1)
  assert.equal(getResearchArtifact(artifactId)?.status, 'ready')
  assert.equal(latestResearchCheckpoint(jobId)?.state.readyToSynthesize, true)
  assert.equal(listResearchJobs().some((job) => job.id === jobId), true, 'library list must restore the persisted report')
}

function verifyCrashRecovery(jobId: string): void {
  updateResearchJob(jobId, { status: 'researching', phase: 'research', nextRunAt: Date.now() })
  assert.equal(acquireResearchLease(jobId, 'stale-owner', 30_000), true)
  getDb().prepare(
    'UPDATE research_jobs SET lease_expires_at = ?, heartbeat_at = ? WHERE id = ?'
  ).run(Date.now() - 5_000, Date.now() - 10_000, jobId)

  const interrupted = startResearchCycle({ jobId, phase: 'research', objective: 'Interrupted process fixture' })
  assert.equal(releaseExpiredResearchLeases(), 1, 'expired work must be released for another scheduler')
  assert.equal(cancelInterruptedResearchCycles(jobId), 2, 'all cycles left running by a crash must be cancelled')
  assert.equal(listResearchCycles(jobId).every((cycle) => cycle.status === 'cancelled'), true)
  assert.match(listResearchCycles(jobId).find((cycle) => cycle.id === interrupted.id)?.error ?? '', /restarted/i)
  assert.equal(listDueResearchJobs(Date.now()).some((job) => job.id === jobId), true, 'recovered work must become schedulable')
}

function verifyArchiveFiltering(): void {
  const id = 'research-archived-job'
  const workspaceDir = initializeResearchWorkspace(id)
  createResearchJob({
    prompt: 'Archived library fixture.',
    providerId: 'claude',
    model: 'claude-sonnet-5',
    depth: 'standard',
    outputFormat: 'pdf',
    autoStart: false
  }, workspaceDir, id)
  archiveResearchJob(id)
  assert.equal(listResearchJobs().some((job) => job.id === id), false, 'default library must hide archived reports')
  assert.equal(listResearchJobs({ includeArchived: true }).some((job) => job.id === id), true)
}

function verifyCascadeDeletion(): void {
  const id = 'research-delete-job'
  const workspaceDir = initializeResearchWorkspace(id)
  createResearchJob({
    prompt: 'Cascade deletion fixture.',
    providerId: 'opencode',
    depth: 'quick',
    outputFormat: 'xlsx',
    autoStart: false
  }, workspaceDir, id)
  const cycle = startResearchCycle({ jobId: id, phase: 'research', objective: 'Cascade child' })
  recordResearchSource({ jobId: id, cycleId: cycle.id, url: 'https://example.org/cascade', title: 'Cascade source' })
  logResearchEvent({ jobId: id, cycleId: cycle.id, kind: 'cycle_started', title: 'Cascade event' })
  assert.equal(deleteResearchJob(id), true)
  assert.equal(getResearchJob(id), null)
  assert.equal(listResearchCycles(id).length, 0)
  assert.equal(listResearchSources(id).length, 0)
  assert.equal(listLatestResearchEvents(id).length, 0)
}

void main().catch((error) => {
  console.error(error)
  closeDb()
  rmSync(isolatedUserData, { recursive: true, force: true })
  app.exit(1)
})

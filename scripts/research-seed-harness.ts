import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { closeDb, initDb } from '../src/main/db.ts'
import {
  EXPECTED_RESEARCH_FIXTURE_COUNT,
  RESEARCH_CORE_FIXTURE_MATRIX,
  createDeterministicResearchDocument,
  type ResearchFixtureCase
} from '../src/main/research/__tests__/fixture-matrix.ts'
import { exportResearchJob } from '../src/main/research/exporters/index.ts'
import { renderResearchMarkdown } from '../src/main/research/exporters/markdown.ts'
import {
  createResearchJob,
  getResearchJob,
  linkResearchClaimSource,
  listResearchArtifacts,
  listResearchClaims,
  listResearchSources,
  logResearchEvent,
  recordResearchClaim,
  recordResearchSource,
  updateResearchJob
} from '../src/main/research/store/index.ts'
import type {
  ResearchArtifact,
  ResearchClaim,
  ResearchPlan,
  ResearchSource
} from '../src/main/research/types.ts'
import {
  RESEARCH_REPORT_FILE,
  initializeResearchWorkspace,
  safeResearchPath,
  writeResearchPlan
} from '../src/main/research/workspace.ts'

interface SeedOptions {
  persist: boolean
}

interface SeedResult {
  id: string
  action: 'created' | 'reused'
  depth: string
  providerClass: string
  format: string
  artifactPath: string
  coverPath: string
}

const QA_SEED_VERSION = 'v1'
const options = parseOptions(process.argv.slice(2))
app.setName('Akorith')
const isolatedUserData = options.persist ? null : mkdtempSync(join(tmpdir(), 'akorith-research-seed-'))
if (isolatedUserData) {
  app.setPath('userData', isolatedUserData)
} else {
  app.setPath('userData', join(app.getPath('appData'), 'Akorith'))
}

async function main(): Promise<void> {
  await app.whenReady()
  if (options.persist) printPersistenceWarning()
  try {
    initDb()
    assert.equal(
      RESEARCH_CORE_FIXTURE_MATRIX.length,
      EXPECTED_RESEARCH_FIXTURE_COUNT,
      'Research QA seed matrix is incomplete'
    )

    const results: SeedResult[] = []
    for (const fixture of RESEARCH_CORE_FIXTURE_MATRIX) {
      results.push(await seedFixture(fixture))
    }

    assert.equal(results.length, 40, 'Research QA library must cover 4 depths × 2 providers × 5 formats')
    assert.equal(new Set(results.map((result) => result.id)).size, 40, 'Research QA fixture IDs must be unique')
    assert.equal(
      results.every((result) => existsSync(result.artifactPath) && existsSync(result.coverPath)),
      true,
      'Every seeded Research item must retain both its artifact and A4 cover'
    )
    const repeated = await Promise.all(RESEARCH_CORE_FIXTURE_MATRIX.map((fixture) => seedFixture(fixture)))
    assert.equal(
      repeated.every((result) => result.action === 'reused'),
      true,
      'Re-running the seed must reuse all 40 valid fixtures without overwriting them'
    )

    const created = results.filter((result) => result.action === 'created').length
    const reused = results.length - created
    console.log(`RESEARCH_SEED_RESULT:${JSON.stringify({
      mode: options.persist ? 'persistent' : 'isolated',
      userData: app.getPath('userData'),
      retainedInLibrary: options.persist,
      created,
      reused,
      total: results.length,
      idempotencyVerified: true,
      results
    })}`)
    console.log(
      options.persist
        ? `Research QA seed complete: ${created} created, ${reused} already valid; 40 fixtures retained in the Akorith library.`
        : 'Research QA seed verified: 40 offline fixtures created in an isolated library and removed after verification.'
    )
  } finally {
    closeDb()
    if (isolatedUserData) rmSync(isolatedUserData, { recursive: true, force: true })
    app.quit()
  }
}

async function seedFixture(fixture: ResearchFixtureCase): Promise<SeedResult> {
  const id = fixtureId(fixture)
  const existing = getResearchJob(id)
  if (existing) return inspectExistingFixture(fixture, id)

  const workspaceDir = initializeResearchWorkspace(id)
  const title = fixtureTitle(fixture)
  createResearchJob({
    title,
    prompt: `[QA OFFLINE FIXTURE] Verify the ${fixture.depth} Research path with ${fixture.providerLabel} and publish a ${fixture.outputFormat.toUpperCase()} deliverable.`,
    providerId: fixture.providerId,
    model: fixture.model,
    depth: fixture.depth,
    outputFormat: fixture.outputFormat,
    autoStart: false
  }, workspaceDir, id)
  logResearchEvent({
    jobId: id,
    kind: 'created',
    title: 'QA fixture created offline',
    detail: `${fixture.depth} · ${fixture.providerLabel} · ${fixture.outputFormat.toUpperCase()} · no provider or network call`
  })

  const baseDocument = createDeterministicResearchDocument(fixture)
  const sourceMap = new Map<string, ResearchSource>()
  for (const source of baseDocument.sources) {
    const persisted = recordResearchSource({
      jobId: id,
      url: source.url,
      title: source.title,
      publisher: source.publisher,
      publishedAt: source.publishedAt,
      excerpt: source.excerpt,
      relevance: source.relevance,
      credibilityScore: source.credibilityScore,
      verified: source.verified
    })
    assert.ok(persisted, `${id} source must pass the production source policy`)
    sourceMap.set(source.id, persisted)
  }

  for (const section of baseDocument.sections) {
    for (const claim of section.claims) {
      const persistedClaim = recordResearchClaim({
        jobId: id,
        sectionId: section.id,
        text: claim.text,
        confidenceScore: claim.confidenceScore,
        status: claim.status
      })
      for (const evidence of claim.evidence) {
        const persistedSource = sourceMap.get(evidence.sourceId)
        assert.ok(persistedSource, `${id} claim evidence must resolve to a persisted source`)
        linkResearchClaimSource({
          claimId: persistedClaim.id,
          sourceId: persistedSource.id,
          relation: evidence.relation,
          evidence: evidence.evidence
        })
      }
    }
  }

  const sources = listResearchSources(id)
  const claims = listResearchClaims(id)
  const document = {
    ...baseDocument,
    title,
    subtitle: 'Deterministic offline QA fixture for the persistent Akorith Research library.',
    requestedBy: 'Akorith Research QA',
    providerLabel: fixture.providerLabel,
    sources,
    sections: baseDocument.sections.map((section) => ({
      ...section,
      claims: claims.filter((claim) => claim.sectionId === section.id)
    }))
  }
  const plan = fixturePlan(document.title, fixture, document.sections)
  writeResearchPlan(workspaceDir, plan)
  writeFileSync(safeResearchPath(workspaceDir, RESEARCH_REPORT_FILE), renderResearchMarkdown(document), 'utf8')
  updateResearchJob(id, {
    plan,
    summary: document.executiveSummary,
    status: 'synthesizing',
    phase: 'synthesize',
    startedAt: document.generatedAt,
    nextRunAt: undefined
  })

  const artifact = await exportResearchJob(id, fixture.outputFormat)
  assertReadyFixtureArtifact(id, artifact)
  updateResearchJob(id, {
    status: 'completed',
    phase: 'export',
    completedAt: document.generatedAt,
    nextRunAt: undefined,
    error: undefined
  })
  logResearchEvent({
    jobId: id,
    kind: 'completed',
    title: 'QA fixture ready',
    detail: `${artifact.format.toUpperCase()} artifact and A4 library cover validated offline`
  })

  return toSeedResult(fixture, id, 'created', artifact)
}

function inspectExistingFixture(fixture: ResearchFixtureCase, id: string): SeedResult {
  const job = getResearchJob(id)!
  assert.equal(job.title, fixtureTitle(fixture), `${id} conflicts with a non-QA Research row; nothing was modified`)
  assert.equal(job.depth, fixture.depth, `${id} has an unexpected depth; nothing was modified`)
  assert.equal(job.providerId, fixture.providerId, `${id} has an unexpected provider; nothing was modified`)
  assert.equal(job.model, fixture.model, `${id} has an unexpected model; nothing was modified`)
  assert.equal(job.outputFormat, fixture.outputFormat, `${id} has an unexpected format; nothing was modified`)
  assert.equal(job.status, 'completed', `${id} is not a completed QA fixture; nothing was modified`)
  const artifact = listResearchArtifacts(id).find((candidate) =>
    candidate.format === fixture.outputFormat && candidate.status === 'ready'
  )
  assert.ok(artifact, `${id} is an incomplete existing QA fixture; nothing was modified`)
  assertReadyFixtureArtifact(id, artifact)
  return toSeedResult(fixture, id, 'reused', artifact)
}

function assertReadyFixtureArtifact(id: string, artifact: ResearchArtifact): void {
  assert.equal(artifact.status, 'ready', `${id} artifact must pass production validation`)
  assert.equal(existsSync(artifact.path), true, `${id} artifact file is missing`)
  assert.ok(artifact.coverPath, `${id} cover path was not recorded`)
  assert.equal(existsSync(artifact.coverPath), true, `${id} A4 cover file is missing`)
  assert.match(
    readFileSync(artifact.coverPath, 'utf8'),
    /width="794" height="1123"/,
    `${id} cover must retain the production A4 portrait dimensions`
  )
  assert.ok(artifact.byteSize > 100, `${id} artifact must contain a non-empty report`)
}

function toSeedResult(
  fixture: ResearchFixtureCase,
  id: string,
  action: SeedResult['action'],
  artifact: ResearchArtifact
): SeedResult {
  return {
    id,
    action,
    depth: fixture.depth,
    providerClass: fixture.providerClass,
    format: fixture.outputFormat,
    artifactPath: artifact.path,
    coverPath: artifact.coverPath!
  }
}

function fixturePlan(
  title: string,
  fixture: ResearchFixtureCase,
  sections: Array<{ id: string; title: string; body: string; claims: ResearchClaim[] }>
): ResearchPlan {
  return {
    title,
    thesis: 'The production Research library can persist and render this complete offline QA combination.',
    deliverable: `${fixture.outputFormat.toUpperCase()} report with an A4 library cover`,
    sections: sections.map((section) => ({
      id: section.id,
      title: section.title,
      objective: section.body,
      queries: ['offline deterministic QA evidence'],
      status: 'complete'
    })),
    sourceStrategy: [
      'Use fixed QA evidence only; do not contact providers or the network.',
      'Persist evidence through the production Research source and claim stores.',
      'Create and validate the selected artifact through the production exporter.'
    ],
    verificationCriteria: [
      'A completed Research library row exists for this exact dimension tuple.',
      'The selected artifact passes production validation and remains on disk.',
      'An A4 portrait Research cover is recorded and remains on disk.'
    ]
  }
}

function fixtureId(fixture: ResearchFixtureCase): string {
  return `qa-research-${QA_SEED_VERSION}-${fixture.depth}-${fixture.providerClass}-${fixture.outputFormat}`
}

function fixtureTitle(fixture: ResearchFixtureCase): string {
  return `QA Fixture · ${capitalize(fixture.depth)} · ${fixture.providerClass === 'free' ? 'OpenCode Free' : 'Claude'} · ${fixture.outputFormat.toUpperCase()}`
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function parseOptions(args: string[]): SeedOptions {
  if (args.includes('--help')) {
    printHelp()
    process.exit(0)
  }
  const unknown = args.filter((argument) => argument !== '--persist')
  assert.deepEqual(unknown, [], `unknown Research seed option: ${unknown.join(', ')}`)
  return { persist: args.includes('--persist') }
}

function printHelp(): void {
  console.log(`Usage: npm run verify:research-seed -- [--persist]

Creates 40 deterministic, QA-labelled Research library fixtures:
  4 depths × 2 provider classes × 5 output formats.

Default (safe): uses a temporary isolated Akorith userData directory, verifies every
artifact and cover, then removes only that temporary directory.

--persist  DANGER / EXPLICIT OPT-IN: writes the 40 fixtures into the real Akorith
           userData and retains their library rows, artifacts, and covers. Existing
           rows and files are never deleted or overwritten. No model or network call
           is made in either mode.
`)
}

function printPersistenceWarning(): void {
  console.warn('')
  console.warn('*** RESEARCH QA SEED --persist ENABLED ***')
  console.warn(`Writing retained fixtures to: ${app.getPath('userData')}`)
  console.warn('This does not delete or overwrite existing Research library data.')
  console.warn('No provider or network call will be made.')
  console.warn('')
}

void main()

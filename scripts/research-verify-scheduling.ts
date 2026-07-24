import assert from 'node:assert/strict'
import {
  chooseResearchSection,
  completedResearchCycleCountAfterSuccess,
  evaluateResearchCompletion,
  nextResearchCycleAt,
  prepareResearchSectionForCycle,
  researchActiveElapsedMs,
  researchTargetDeadline,
  SUSTAINED_LOCAL_RESEARCH_COOLDOWN_MS
} from '../src/main/research/policy.ts'
import {
  RESEARCH_DEPTH_PROFILES,
  type ResearchJob,
  type ResearchPlan
} from '../src/main/research/types.ts'

const START = Date.UTC(2026, 6, 19, 8, 0, 0)

const completePlan: ResearchPlan = {
  title: 'Duration policy fixture',
  thesis: 'Bounded research must honor its advertised duration.',
  deliverable: 'A verified report.',
  sections: [
    {
      id: 'primary-evidence',
      title: 'Primary evidence',
      objective: 'Establish the primary evidence.',
      queries: ['official evidence', 'primary dataset'],
      status: 'complete'
    },
    {
      id: 'independent-check',
      title: 'Independent check',
      objective: 'Corroborate the primary evidence independently.',
      queries: ['independent analysis', 'critical review'],
      status: 'complete'
    }
  ],
  sourceStrategy: ['Primary sources', 'Independent corroboration'],
  verificationCriteria: ['Material claims are cited.']
}

function researchJob(overrides: Partial<ResearchJob> = {}): ResearchJob {
  return {
    id: 'duration-policy-job',
    title: 'Duration policy fixture',
    prompt: 'Verify the bounded research duration policy.',
    status: 'researching',
    phase: 'research',
    providerId: 'opencode',
    model: 'fixture-model',
    depth: 'standard',
    outputFormat: 'md',
    targetDurationMs: RESEARCH_DEPTH_PROFILES.standard.targetDurationMs,
    maxCycles: RESEARCH_DEPTH_PROFILES.standard.maxCycles,
    sourceTarget: RESEARCH_DEPTH_PROFILES.standard.sourceTarget,
    cycleCount: RESEARCH_DEPTH_PROFILES.standard.maxCycles,
    sourceCount: RESEARCH_DEPTH_PROFILES.standard.sourceTarget,
    findingCount: 24,
    workspaceDir: 'C:\\research-fixture',
    plan: completePlan,
    createdAt: START - 24 * 60 * 60_000,
    updatedAt: START,
    startedAt: START,
    activeElapsedMs: 0,
    revision: 0,
    ...overrides
  }
}

const readyCoverage = { total: 20, coverage: 0.9 }

const pendingPlan: ResearchPlan = {
  ...completePlan,
  sections: completePlan.sections.map((section) => ({ ...section, status: 'pending' }))
}

const standard = researchJob({ activeElapsedMs: RESEARCH_DEPTH_PROFILES.standard.targetDurationMs - 1 })
const oneMillisecondEarly = evaluateResearchCompletion({
  job: standard,
  plan: completePlan,
  coverage: readyCoverage,
  now: START
})
assert.equal(oneMillisecondEarly.evidenceReady, true, 'cycle/source readiness should remain independently visible')
assert.equal(oneMillisecondEarly.targetDurationReached, false)
assert.equal(oneMillisecondEarly.shouldSynthesize, false, 'a bounded job must never finish before its target duration')

const exactlyOnTime = evaluateResearchCompletion({
  job: { ...standard, activeElapsedMs: standard.targetDurationMs },
  plan: completePlan,
  coverage: readyCoverage,
  now: START
})
assert.equal(exactlyOnTime.targetDurationReached, true)
assert.equal(exactlyOnTime.shouldSynthesize, true, 'a ready bounded job may finish at its persisted deadline')

const deep = researchJob({
  depth: 'deep',
  targetDurationMs: RESEARCH_DEPTH_PROFILES.deep.targetDurationMs,
  maxCycles: RESEARCH_DEPTH_PROFILES.deep.maxCycles,
  cycleCount: RESEARCH_DEPTH_PROFILES.deep.maxCycles,
  sourceTarget: RESEARCH_DEPTH_PROFILES.deep.sourceTarget,
  sourceCount: RESEARCH_DEPTH_PROFILES.deep.sourceTarget,
  activeElapsedMs: Math.round(3.404 * 60 * 60_000)
})
const productionLikeEarlyFinish = evaluateResearchCompletion({
  job: deep,
  plan: completePlan,
  coverage: readyCoverage,
  now: START
})
assert.equal(productionLikeEarlyFinish.evidenceReady, true)
assert.equal(productionLikeEarlyFinish.shouldSynthesize, false, '72/72 cycles at 3.404h cannot finish a 12h job')

const sourceReadyEarly = evaluateResearchCompletion({
  job: researchJob({ cycleCount: 2, activeElapsedMs: 10 * 60_000 }),
  plan: completePlan,
  coverage: readyCoverage,
  now: START
})
assert.equal(sourceReadyEarly.evidenceReady, false)
assert.equal(sourceReadyEarly.shouldSynthesize, false, 'completed sections and source coverage cannot bypass time')

const elapsedButBudgetRemaining = evaluateResearchCompletion({
  job: researchJob({
    cycleCount: RESEARCH_DEPTH_PROFILES.standard.maxCycles - 1,
    activeElapsedMs: RESEARCH_DEPTH_PROFILES.standard.targetDurationMs
  }),
  plan: completePlan,
  coverage: readyCoverage,
  now: START
})
assert.equal(elapsedButBudgetRemaining.targetDurationReached, true)
assert.equal(elapsedButBudgetRemaining.cycleBudgetUsed, false)
assert.equal(elapsedButBudgetRemaining.shouldSynthesize, false, 'elapsed time cannot replace the promised cycle budget')

assert.equal(
  chooseResearchSection(completePlan, 2),
  null,
  'the default selection keeps continuous snapshot behavior unchanged'
)
const revisited = chooseResearchSection(completePlan, 2, { revisitCompleted: true })
assert.equal(revisited?.id, 'primary-evidence', 'bounded jobs must round-robin completed sections')
const followUp = prepareResearchSectionForCycle(revisited!, 2)
assert.equal(followUp.status, 'active')
assert.match(followUp.objective, /Follow-up verification/)
assert.notDeepEqual(followUp.queries, revisited?.queries, 'follow-up searches must rotate and refine prior queries')
assert.match(followUp.queries[0], /contradictory evidence|recent developments|primary source|independent corroboration/)

const standardAfterFirstCycle = researchJob({ cycleCount: 1, activeElapsedMs: 2 * 60_000 })
const standardNext = nextResearchCycleAt(standardAfterFirstCycle, START)
assert.ok(
  standardNext - START > 5 * 60_000,
  'standard cycles should be paced over the remaining hour instead of using the 45s floor'
)
assert.ok(standardNext <= START + standardAfterFirstCycle.targetDurationMs)

const exhaustedDeepNext = nextResearchCycleAt(deep, START)
assert.equal(
  exhaustedDeepNext,
  START + deep.targetDurationMs / deep.maxCycles,
  'an exhausted historical job should keep corroborating at the nominal cadence'
)

const sustainedLocalDeep = researchJob({
  providerId: 'local',
  depth: 'deep',
  targetDurationMs: RESEARCH_DEPTH_PROFILES.deep.targetDurationMs,
  maxCycles: RESEARCH_DEPTH_PROFILES.deep.maxCycles,
  cycleCount: 1,
  activeElapsedMs: 2 * 60_000
})
assert.equal(
  nextResearchCycleAt(sustainedLocalDeep, START),
  START + SUSTAINED_LOCAL_RESEARCH_COOLDOWN_MS,
  'local Deep research should keep the GPU fed after a short cooperative cooldown'
)
const sustainedLocalStandard = researchJob({
  providerId: 'local',
  depth: 'standard',
  cycleCount: 1,
  activeElapsedMs: 2 * 60_000
})
assert.equal(
  nextResearchCycleAt(sustainedLocalStandard, START),
  START + SUSTAINED_LOCAL_RESEARCH_COOLDOWN_MS,
  'one-hour local Standard research should keep the GPU fed after a short cooperative cooldown'
)
assert.ok(
  exhaustedDeepNext - START > SUSTAINED_LOCAL_RESEARCH_COOLDOWN_MS,
  'non-local Deep research must preserve the existing paced cadence'
)

const overdueWithCyclesRemaining = researchJob({
  cycleCount: 3,
  activeElapsedMs: RESEARCH_DEPTH_PROFILES.standard.targetDurationMs
})
const overdueNow = START
assert.equal(
  nextResearchCycleAt(overdueWithCyclesRemaining, overdueNow),
  START + RESEARCH_DEPTH_PROFILES.standard.cycleIntervalMs,
  'an overdue job must retain the normal cadence instead of spinning through remaining calls'
)
const overdueAfterBudget = researchJob({
  activeElapsedMs: RESEARCH_DEPTH_PROFILES.standard.targetDurationMs
})
assert.equal(
  nextResearchCycleAt(overdueAfterBudget, START),
  START + RESEARCH_DEPTH_PROFILES.standard.targetDurationMs / RESEARCH_DEPTH_PROFILES.standard.maxCycles,
  'evidence follow-ups after the budget must use the measured nominal cadence'
)

const continuous = researchJob({
  depth: 'continuous',
  targetDurationMs: 0,
  maxCycles: 0,
  sourceTarget: 0,
  cycleCount: 9,
  sourceCount: 12
})
const continuousReady = evaluateResearchCompletion({
  job: continuous,
  plan: completePlan,
  coverage: readyCoverage,
  now: START + 365 * 24 * 60 * 60_000
})
assert.equal(continuousReady.targetDurationReached, false)
assert.equal(continuousReady.shouldSynthesize, true, 'continuous snapshots remain evidence-driven')

const continuousPending = evaluateResearchCompletion({
  job: continuous,
  plan: pendingPlan,
  coverage: readyCoverage,
  now: START + 365 * 24 * 60 * 60_000
})
assert.equal(continuousPending.allSectionsComplete, false)
assert.equal(continuousPending.shouldSynthesize, false, 'continuous snapshots still require every section to complete')
assert.equal(
  nextResearchCycleAt(continuous, START),
  START + RESEARCH_DEPTH_PROFILES.continuous.cycleIntervalMs,
  'continuous cadence must remain unchanged'
)

const queuedOrOffline = researchJob({
  createdAt: START - 24 * 60 * 60_000,
  startedAt: START - 12 * 60 * 60_000,
  activeElapsedMs: 0,
  activeAccountingAt: undefined
})
assert.equal(researchActiveElapsedMs(queuedOrOffline, START), 0)
assert.equal(
  evaluateResearchCompletion({ job: queuedOrOffline, plan: completePlan, coverage: readyCoverage, now: START }).shouldSynthesize,
  false,
  'queue and app-offline wall time must not consume the active research promise'
)
assert.equal(researchTargetDeadline(queuedOrOffline, START), START + queuedOrOffline.targetDurationMs)

const liveClock = researchJob({ activeElapsedMs: 20_000, activeAccountingAt: START })
assert.equal(researchActiveElapsedMs(liveClock, START + 5_000), 25_000)

const noEvidence = researchJob({ activeElapsedMs: RESEARCH_DEPTH_PROFILES.standard.targetDurationMs, sourceCount: 0 })
const zeroEvidenceDecision = evaluateResearchCompletion({
  job: noEvidence,
  plan: completePlan,
  coverage: { total: 0, coverage: 0 },
  now: START
})
assert.equal(zeroEvidenceDecision.evidenceReady, false)
assert.equal(zeroEvidenceDecision.shouldSynthesize, false, 'elapsed time and cycles cannot publish a zero-evidence report')

const emptyPlanDecision = evaluateResearchCompletion({
  job: { ...standard, activeElapsedMs: standard.targetDurationMs },
  plan: { ...completePlan, sections: [] },
  coverage: readyCoverage,
  now: START
})
assert.equal(emptyPlanDecision.evidenceReady, false)
assert.equal(emptyPlanDecision.shouldSynthesize, false, 'an empty evidence plan must never pass the completion gate')

const boundedPending = evaluateResearchCompletion({
  job: {
    ...standard,
    activeElapsedMs: standard.targetDurationMs,
    cycleCount: standard.maxCycles,
    sourceCount: RESEARCH_DEPTH_PROFILES.standard.sourceTarget
  },
  plan: pendingPlan,
  coverage: readyCoverage,
  now: START
})
assert.equal(boundedPending.allSectionsComplete, false)
assert.equal(boundedPending.evidenceReady, true)
assert.equal(
  boundedPending.shouldSynthesize,
  true,
  'a bounded job must finish after duration, cycle, source, and coverage gates even if section flags stay pending'
)

assert.equal(completedResearchCycleCountAfterSuccess(0), 1)
assert.equal(completedResearchCycleCountAfterSuccess(11), 12)
assert.notEqual(
  completedResearchCycleCountAfterSuccess(0),
  72,
  'a high failed-attempt index must never inflate the successful-cycle count'
)

const smokeOverride = researchJob({ targetDurationMs: 0, maxCycles: 1, cycleCount: 1, activeElapsedMs: 0 })
assert.equal(
  evaluateResearchCompletion({ job: smokeOverride, plan: completePlan, coverage: readyCoverage, now: START }).shouldSynthesize,
  true,
  'an explicit zero-duration bounded test override may finish immediately'
)

console.log('research scheduling verifier passed (active duration, evidence gates, successful cycles, paced follow-ups, and continuous semantics)')

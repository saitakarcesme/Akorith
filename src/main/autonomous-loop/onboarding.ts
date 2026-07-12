import { randomUUID } from 'node:crypto'
import {
  RepositoryError,
  parseGitHubRepositoryUrl,
  safeRepositorySlug,
  type CloneRepositoryResult,
  type CreateProjectInput,
  type CreateProjectResult,
  type GitHubRepositoryCreateRequest,
  type GitHubRepositoryCreateResult,
  type PushResult,
  type RemoteAccessInspection,
  type RepositoryInspection,
  type RepositoryRemote
} from '../repository'
import {
  evaluateLoopExecutorEligibility,
  evaluatePlannerEligibility,
  type CatalogModel,
  type ModelCatalogService
} from '../model-catalog'
import type { LoopModelDecision } from './engine-types'
import {
  ProviderLoopIdentityPlanner,
  type InitialProjectIdentity,
  type LoopIdentityPlanner
} from './onboarding-identity'
import type { AutonomousLoopStore } from './store'
import {
  type AutonomousLoopRecord,
  type CreateAutonomousLoopInput,
  type LoopExecutorSelection,
  type LoopPlannerSelection
} from './types'
import { validateCreateAutonomousLoopInput } from './validation'

const ACTIVE_STATUSES = new Set(['setting_up', 'running', 'pausing', 'paused', 'stopping'])

export interface LoopOnboardingRepository {
  cloneGitHub(url: string, signal?: AbortSignal): Promise<CloneRepositoryResult>
  createProjectInParent(parentPath: string, input: CreateProjectInput): Promise<CreateProjectResult>
  createGitHubRepository(request: GitHubRepositoryCreateRequest, signal?: AbortSignal): Promise<GitHubRepositoryCreateResult>
  addRemote(repositoryPath: string, remote: RepositoryRemote, options?: { name?: string; replaceMismatched?: boolean }): Promise<string>
  inspectRemote(repositoryPath: string, remoteName?: string): Promise<RemoteAccessInspection>
  push(repositoryPath: string, options?: { branch?: string; remoteName?: string; setUpstream?: boolean }): Promise<PushResult>
}

export interface LoopOnboardingOptions {
  store: AutonomousLoopStore
  repository: LoopOnboardingRepository
  catalog: Pick<ModelCatalogService, 'discover'>
  identityPlanner?: LoopIdentityPlanner
  identity?: { name: string; email: string }
  now?: () => number
  createId?: () => string
}

export interface LoopOnboardingReview {
  loop: AutonomousLoopRecord
  executorModel: CatalogModel
  plannerModel: CatalogModel | null
  plannerLabel: string
  remoteAccess: RemoteAccessInspection
  detectedCommands: RepositoryInspection['technology']['commands']
  initialIdentity: InitialProjectIdentity | null
}

function modelMatchesExecutor(model: CatalogModel, selection: LoopExecutorSelection): boolean {
  const selectionNode = selection.nodeId ?? (selection.location === 'local' ? 'this-device' : null)
  return model.id === selection.catalogId &&
    model.providerId === selection.providerId &&
    model.modelName === selection.model &&
    model.source === selection.location &&
    model.nodeId === selectionNode &&
    model.latestProbe?.id === selection.capabilityProbeId
}

function modelMatchesPlanner(model: CatalogModel, selection: LoopPlannerSelection): boolean {
  const selectionNode = selection.nodeId ?? (selection.location === 'local' ? 'this-device' : null)
  return model.id === selection.catalogId &&
    model.providerId === selection.providerId &&
    model.modelName === selection.model &&
    model.source === selection.location &&
    model.nodeId === selectionNode
}

function plannerSelection(model: CatalogModel): LoopPlannerSelection {
  return {
    catalogId: model.id,
    providerId: model.providerId,
    model: model.modelName,
    location: model.source,
    nodeId: model.nodeId ?? undefined
  }
}

function choosePlanner(models: readonly CatalogModel[], now: number): CatalogModel | null {
  const sourceScore = { cloud: 3, remote: 2, local: 1 } as const
  return models
    .filter((model) => evaluatePlannerEligibility(model, now).selectable)
    .sort((left, right) =>
      sourceScore[right.source] - sourceScore[left.source] ||
      (right.contextWindowTokens ?? 0) - (left.contextWindowTokens ?? 0) ||
      left.displayLabel.localeCompare(right.displayLabel)
    )[0] ?? null
}

function deterministicPlannerSelection(): LoopPlannerSelection {
  return {
    catalogId: 'akorith:evidence-planner',
    providerId: 'akorith',
    model: 'evidence-planner',
    location: 'local'
  }
}

function ensurePushAccess(access: RemoteAccessInspection): void {
  if (access.reachable && access.repositoryExists !== false && access.canPush === true) return
  const code = access.errorCode === 'authentication-required' || access.authState === 'required'
    ? 'authentication-required'
    : access.repositoryExists === false
      ? 'remote-not-found'
      : 'push-permission-denied'
  throw new RepositoryError(code, access.message || 'The configured Git remote is not writable.', {
    operation: 'validate Loop repository push access',
    recoverable: true
  })
}

export class LoopOnboardingService {
  private readonly identityPlanner: LoopIdentityPlanner
  private readonly now: () => number
  private readonly createId: () => string
  private readonly identity: { name: string; email: string }

  constructor(private readonly options: LoopOnboardingOptions) {
    this.identityPlanner = options.identityPlanner ?? new ProviderLoopIdentityPlanner()
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? randomUUID
    this.identity = options.identity ?? { name: 'Akorith Loop', email: 'loop@akorith.local' }
  }

  private assertRepositoryAvailable(repositoryId: string): void {
    const conflict = this.options.store.listLoops(1_000).find((loop) =>
      loop.repositoryId === repositoryId && ACTIVE_STATUSES.has(loop.status)
    )
    if (conflict) {
      throw new RepositoryError('lock-conflict', `“${conflict.projectName}” already has an active Loop.`, {
        operation: 'create autonomous Loop', recoverable: true
      })
    }
  }

  async create(rawInput: unknown, signal?: AbortSignal): Promise<LoopOnboardingReview> {
    const validated = validateCreateAutonomousLoopInput(rawInput)
    if (!validated.ok) {
      throw new RepositoryError('invalid-response', validated.error, {
        operation: 'validate autonomous Loop setup', recoverable: true
      })
    }
    const input: CreateAutonomousLoopInput = validated.value
    const discovered = await this.options.catalog.discover(signal)
    const executorModel = discovered.catalog.models.find((model) => modelMatchesExecutor(model, input.executor))
    if (!executorModel) {
      throw new RepositoryError('adapter-unavailable', 'The selected executor no longer matches the live model catalog or capability probe.', {
        operation: 'validate Loop executor', recoverable: true
      })
    }
    const eligibility = evaluateLoopExecutorEligibility(executorModel, this.now())
    if (!eligibility.selectable) {
      throw new RepositoryError('adapter-unavailable', eligibility.reason, {
        operation: 'validate Loop executor', recoverable: true,
        detail: eligibility.missingCapabilities.join(', ')
      })
    }
    const executor: LoopExecutorSelection = {
      ...input.executor,
      nodeId: executorModel.nodeId ?? undefined
    }

    let plannerModel: CatalogModel | null = null
    let planner: LoopPlannerSelection
    if (input.planner) {
      plannerModel = discovered.catalog.models.find((model) => modelMatchesPlanner(model, input.planner!)) ?? null
      if (!plannerModel) {
        throw new RepositoryError('adapter-unavailable', 'The selected planner is no longer present in the live model catalog.', {
          operation: 'validate Loop planner', recoverable: true
        })
      }
      const plannerEligibility = evaluatePlannerEligibility(plannerModel, this.now())
      if (!plannerEligibility.selectable) {
        throw new RepositoryError('adapter-unavailable', plannerEligibility.reason, {
          operation: 'validate Loop planner', recoverable: true
        })
      }
      planner = plannerSelection(plannerModel)
    } else {
      plannerModel = choosePlanner(discovered.catalog.models, this.now())
      planner = plannerModel ? plannerSelection(plannerModel) : deterministicPlannerSelection()
    }

    let inspection: RepositoryInspection
    let projectName: string
    let workspacePath: string
    let remoteUrl: string
    let repositoryId: string
    let access: RemoteAccessInspection
    let identityDecision: LoopModelDecision<InitialProjectIdentity> | null = null
    let initialCommitAndPush = false

    if (input.source.kind === 'existing_github') {
      const parsed = parseGitHubRepositoryUrl(input.source.remoteUrl)
      this.assertRepositoryAvailable(parsed.canonicalId)
      const cloned = await this.options.repository.cloneGitHub(parsed.cloneUrl, signal)
      projectName = parsed.repository
      workspacePath = cloned.path
      remoteUrl = parsed.httpsUrl
      repositoryId = parsed.canonicalId
      inspection = cloned.inspection
      access = await this.options.repository.inspectRemote(workspacePath, 'origin')
      ensurePushAccess(access)
    } else {
      let parsed = input.source.remoteUrl ? parseGitHubRepositoryUrl(input.source.remoteUrl) : null
      if (!parsed) {
        const createdRemote = await this.options.repository.createGitHubRepository({
          owner: input.source.githubOwner!,
          name: safeRepositorySlug(input.source.projectName),
          description: `Akorith Loop project: ${input.source.projectName}`,
          visibility: input.source.githubVisibility ?? 'private',
          initialize: false
        }, signal)
        parsed = parseGitHubRepositoryUrl(createdRemote.httpsUrl)
      }
      this.assertRepositoryAvailable(parsed.canonicalId)
      identityDecision = await this.identityPlanner.plan({
        projectName: input.source.projectName,
        remoteUrl: parsed.httpsUrl,
        planner,
        signal
      })
      const created = await this.options.repository.createProjectInParent(input.source.parentPath, {
        name: input.source.projectName,
        summary: identityDecision.value.summary,
        plan: identityDecision.value.plan,
        identity: this.identity,
        branch: 'main'
      })
      projectName = input.source.projectName
      workspacePath = created.path
      remoteUrl = parsed.httpsUrl
      repositoryId = parsed.canonicalId
      inspection = created.inspection
      await this.options.repository.addRemote(workspacePath, parsed, { name: 'origin' })
      access = await this.options.repository.inspectRemote(workspacePath, 'origin')
      ensurePushAccess(access)
      await this.options.repository.push(workspacePath, {
        branch: inspection.branch ?? inspection.defaultBranch,
        remoteName: 'origin',
        setUpstream: true
      })
      initialCommitAndPush = true
    }

    const timestamp = this.now()
    const loop: AutonomousLoopRecord = {
      id: this.createId(),
      projectName,
      status: 'running',
      stage: 'scheduling',
      repositoryId,
      workspacePath,
      remoteUrl,
      branch: inspection.branch ?? inspection.defaultBranch,
      executor,
      planner,
      limits: {
        maxRepairAttempts: input.limits?.maxRepairAttempts ?? 3,
        maxConsecutiveInfrastructureFailures: input.limits?.maxConsecutiveInfrastructureFailures ?? 5,
        tokenLimit: input.limits?.tokenLimit ?? null,
        costLimitUsd: input.limits?.costLimitUsd ?? null,
        validationTimeoutMs: input.limits?.validationTimeoutMs ?? 10 * 60_000
      },
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: timestamp,
      pausedAt: null,
      stoppedAt: null,
      completedAt: null,
      lastActivityAt: timestamp,
      nextCycleAt: timestamp,
      activeCycleId: null,
      consecutiveInfrastructureFailures: 0,
      tokenUsage: identityDecision?.usage ?? { input: 0, output: 0, cached: 0, costUsd: 0 },
      commitCount: initialCommitAndPush ? 1 : 0,
      pushCount: initialCommitAndPush ? 1 : 0,
      successfulTasks: 0,
      failedTasks: 0,
      stopReason: null,
      error: null
    }
    this.options.store.createLoop(loop)
    if (identityDecision) {
      this.options.store.recordModelCall({
        loopId: loop.id,
        role: 'planner',
        providerId: planner.providerId,
        model: planner.model,
        catalogId: planner.catalogId,
        location: planner.location,
        nodeId: planner.nodeId,
        durationMs: identityDecision.durationMs,
        tokenUsage: identityDecision.usage,
        estimated: identityDecision.estimated,
        outcome: 'completed'
      })
    }
    this.options.store.appendEvent({
      loopId: loop.id,
      cycleId: null,
      occurredAt: timestamp,
      stage: 'scheduling',
      level: 'success',
      kind: 'loop-created',
      title: 'Autonomous Loop started',
      summary: `Repository and model checks passed. ${plannerModel ? plannerModel.displayLabel : 'Akorith evidence planner'} will select the first task.`,
      details: {
        branch: loop.branch,
        executor: executorModel.displayLabel,
        planner: plannerModel?.displayLabel ?? 'Akorith evidence planner',
        initialCommitAndPush
      }
    })
    return {
      loop,
      executorModel,
      plannerModel,
      plannerLabel: plannerModel?.displayLabel ?? 'Akorith evidence planner',
      remoteAccess: access,
      detectedCommands: inspection.technology.commands,
      initialIdentity: identityDecision?.value ?? null
    }
  }
}

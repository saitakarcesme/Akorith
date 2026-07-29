import { ipcMain, shell } from 'electron'
import { ensureDbReady } from '../db'
import {
  cancelActiveResearchRun,
  getResearchSchedulerSnapshot,
  isResearchJobRunning,
  kickResearchScheduler,
  pauseScheduledResearchJob,
  resumeScheduledResearchJob
} from './scheduler'
import { RESEARCH_OUTPUT_FORMATS, type CreateResearchJobInput, type ResearchOutputFormat } from './types'
import { getResearchSource } from './store'
import {
  getResearchDiscordPublicSettings,
  researchDiscordDeliveriesForJob,
  retryManagedResearchDiscordDelivery,
  testResearchDiscordDelivery,
  updateResearchDiscordSettings,
  type ResearchDiscordSettingsPatch
} from './discord-delivery'

export function registerResearchIpc(): void {
  ipcMain.handle('research:list', async () => {
    await ensureDbReady()
    return (await researchService()).listResearchLibrary()
  })

  ipcMain.handle('research:get', async (_event, input: unknown) => {
    await ensureDbReady()
    const id = requireId(input, 'research job')
    return { ...(await researchService()).getResearchJobDetail(id), running: isResearchJobRunning(id) }
  })

  ipcMain.handle('research:poll', async (_event, input: unknown) => {
    await ensureDbReady()
    if (!isRecord(input)) throw new Error('invalid research poll request')
    const id = requireId(input.id, 'research job')
    const version = typeof input.version === 'string' && input.version.length <= 512
      ? input.version
      : undefined
    return (await researchService()).pollResearchJob(id, isResearchJobRunning(id), version)
  })

  ipcMain.handle('research:essay', async (_event, input: unknown) => {
    await ensureDbReady()
    return (await researchService()).getResearchEssayPreview(requireId(input, 'research job'))
  })

  ipcMain.handle('research:create', async (_event, input: unknown) => {
    await ensureDbReady()
    const job = (await researchService()).createManagedResearchJob(requireCreateInput(input))
    if (job.status !== 'draft') kickResearchScheduler()
    return job
  })

  ipcMain.handle('research:pause', async (_event, input: unknown) => {
    await ensureDbReady()
    return pauseScheduledResearchJob(requireId(input, 'research job'))
  })

  ipcMain.handle('research:resume', async (_event, input: unknown) => {
    await ensureDbReady()
    return resumeScheduledResearchJob(requireId(input, 'research job'))
  })

  ipcMain.handle('research:archive', async (_event, input: unknown) => {
    await ensureDbReady()
    const id = requireId(input, 'research job')
    cancelActiveResearchRun(id)
    return (await researchService()).archiveManagedResearchJob(id)
  })

  ipcMain.handle('research:delete', async (_event, input: unknown) => {
    await ensureDbReady()
    const id = requireId(input, 'research job')
    cancelActiveResearchRun(id)
    return (await researchService()).deleteManagedResearchJob(id)
  })

  ipcMain.handle('research:export', async (_event, input: unknown) => {
    await ensureDbReady()
    if (!isRecord(input)) throw new Error('invalid research export request')
    const jobId = requireId(input.jobId, 'research job')
    const format = input.format
    if (typeof format !== 'string' || !RESEARCH_OUTPUT_FORMATS.includes(format as ResearchOutputFormat)) {
      throw new Error('invalid research output format')
    }
    const { exportResearchJob } = await import('./exporters')
    return exportResearchJob(jobId, format as ResearchOutputFormat)
  })

  ipcMain.handle('research:openArtifact', async (_event, input: unknown) => {
    await ensureDbReady()
    await (await researchService()).openResearchArtifact(requireId(input, 'research artifact'))
    return true
  })

  ipcMain.handle('research:revealArtifact', async (_event, input: unknown) => {
    await ensureDbReady()
    const service = await researchService()
    service.revealResearchArtifact(requireId(input, 'research artifact'))
    return true
  })

  ipcMain.handle('research:coverDataUrl', async (_event, input: unknown) => {
    await ensureDbReady()
    return (await researchService()).researchCoverDataUrl(requireId(input, 'research job'))
  })

  ipcMain.handle('research:openSource', async (_event, input: unknown) => {
    await ensureDbReady()
    const source = getResearchSource(requireId(input, 'research source'))
    if (!source) throw new Error('Research source is unavailable.')
    await shell.openExternal(requirePublicWebUrl(source.url))
    return true
  })

  ipcMain.handle('research:scheduler', async () => {
    await ensureDbReady()
    return getResearchSchedulerSnapshot()
  })

  ipcMain.handle('research:discordSettings', async () => {
    await ensureDbReady()
    return getResearchDiscordPublicSettings()
  })

  ipcMain.handle('research:setDiscordSettings', async (_event, input: unknown) => {
    await ensureDbReady()
    return updateResearchDiscordSettings(requireDiscordSettingsPatch(input))
  })

  ipcMain.handle('research:testDiscord', async () => {
    await ensureDbReady()
    return testResearchDiscordDelivery()
  })

  ipcMain.handle('research:discordDeliveries', async (_event, input: unknown) => {
    await ensureDbReady()
    return researchDiscordDeliveriesForJob(requireId(input, 'research job'))
  })

  ipcMain.handle('research:retryDiscordDelivery', async (_event, input: unknown) => {
    await ensureDbReady()
    return retryManagedResearchDiscordDelivery(requireId(input, 'Discord delivery'))
  })
}

function requireDiscordSettingsPatch(input: unknown): ResearchDiscordSettingsPatch {
  if (!isRecord(input)) throw new Error('invalid Research Discord settings')
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw new Error('invalid Research Discord enabled setting')
  }
  if (
    input.webhookUrl !== undefined &&
    input.webhookUrl !== null &&
    (typeof input.webhookUrl !== 'string' || input.webhookUrl.length > 2_048 || /[\0\r\n]/.test(input.webhookUrl))
  ) {
    throw new Error('invalid Research Discord webhook')
  }
  return {
    ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
    ...(input.webhookUrl === null || typeof input.webhookUrl === 'string'
      ? { webhookUrl: input.webhookUrl }
      : {})
  }
}

function requireCreateInput(input: unknown): CreateResearchJobInput {
  if (!isRecord(input)) throw new Error('invalid research input')
  const mode = input.mode === 'autoresearch' ? 'autoresearch' : 'evidence'
  return {
    prompt: input.prompt as string,
    title: typeof input.title === 'string' ? input.title : undefined,
    providerId: input.providerId as string,
    model: typeof input.model === 'string' ? input.model : undefined,
    depth: input.depth as CreateResearchJobInput['depth'],
    outputFormat: input.outputFormat as CreateResearchJobInput['outputFormat'],
    mode,
    autoresearch: mode === 'autoresearch' ? requireAutoresearchInput(input.autoresearch) : undefined,
    autoStart: input.autoStart !== false
  }
}

function researchService() {
  return import('./service')
}

function requireAutoresearchInput(input: unknown): NonNullable<CreateResearchJobInput['autoresearch']> {
  if (!isRecord(input) || !isRecord(input.target)) throw new Error('invalid Autoresearch configuration')
  const target = input.target.kind === 'karpathy-starter'
    ? { kind: 'karpathy-starter' as const }
    : input.target.kind === 'project' && typeof input.target.projectId === 'string'
      ? { kind: 'project' as const, projectId: input.target.projectId }
      : null
  if (!target) throw new Error('invalid Autoresearch target')
  return {
    target,
    command: typeof input.command === 'string' ? input.command : undefined,
    metricName: typeof input.metricName === 'string' ? input.metricName : undefined,
    metricPattern: typeof input.metricPattern === 'string' ? input.metricPattern : undefined,
    metricDirection: input.metricDirection === 'maximize' ? 'maximize' : 'minimize',
    editablePaths: Array.isArray(input.editablePaths)
      ? input.editablePaths.filter((value): value is string => typeof value === 'string')
      : undefined,
    experimentTimeoutMinutes: typeof input.experimentTimeoutMinutes === 'number'
      ? input.experimentTimeoutMinutes
      : undefined
  }
}

function requireId(input: unknown, label: string): string {
  if (typeof input !== 'string' || !/^[\w-]{1,64}$/.test(input)) throw new Error(`invalid ${label} id`)
  return input
}

function requirePublicWebUrl(input: unknown): string {
  if (typeof input !== 'string' || input.length > 4_096) throw new Error('invalid research source URL')
  const url = new URL(input)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('invalid research source URL')
  return url.toString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

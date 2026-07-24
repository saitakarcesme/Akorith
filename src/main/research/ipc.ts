import { ipcMain, shell } from 'electron'
import { ensureDbReady } from '../db'
import { exportResearchJob } from './exporters'
import {
  cancelActiveResearchRun,
  getResearchSchedulerSnapshot,
  isResearchJobRunning,
  kickResearchScheduler,
  pauseScheduledResearchJob,
  resumeScheduledResearchJob
} from './scheduler'
import {
  archiveManagedResearchJob,
  createManagedResearchJob,
  deleteManagedResearchJob,
  getResearchJobDetail,
  listResearchLibrary,
  openResearchArtifact,
  researchCoverDataUrl,
  revealResearchArtifact
} from './service'
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
    return listResearchLibrary()
  })

  ipcMain.handle('research:get', async (_event, input: unknown) => {
    await ensureDbReady()
    const id = requireId(input, 'research job')
    return { ...getResearchJobDetail(id), running: isResearchJobRunning(id) }
  })

  ipcMain.handle('research:create', async (_event, input: unknown) => {
    await ensureDbReady()
    const job = createManagedResearchJob(requireCreateInput(input))
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
    return archiveManagedResearchJob(id)
  })

  ipcMain.handle('research:delete', async (_event, input: unknown) => {
    await ensureDbReady()
    const id = requireId(input, 'research job')
    cancelActiveResearchRun(id)
    return deleteManagedResearchJob(id)
  })

  ipcMain.handle('research:export', async (_event, input: unknown) => {
    await ensureDbReady()
    if (!isRecord(input)) throw new Error('invalid research export request')
    const jobId = requireId(input.jobId, 'research job')
    const format = input.format
    if (typeof format !== 'string' || !RESEARCH_OUTPUT_FORMATS.includes(format as ResearchOutputFormat)) {
      throw new Error('invalid research output format')
    }
    return exportResearchJob(jobId, format as ResearchOutputFormat)
  })

  ipcMain.handle('research:openArtifact', async (_event, input: unknown) => {
    await ensureDbReady()
    await openResearchArtifact(requireId(input, 'research artifact'))
    return true
  })

  ipcMain.handle('research:revealArtifact', async (_event, input: unknown) => {
    await ensureDbReady()
    revealResearchArtifact(requireId(input, 'research artifact'))
    return true
  })

  ipcMain.handle('research:coverDataUrl', async (_event, input: unknown) => {
    await ensureDbReady()
    return researchCoverDataUrl(requireId(input, 'research job'))
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
  return {
    prompt: input.prompt as string,
    title: typeof input.title === 'string' ? input.title : undefined,
    providerId: input.providerId as string,
    model: typeof input.model === 'string' ? input.model : undefined,
    depth: input.depth as CreateResearchJobInput['depth'],
    outputFormat: input.outputFormat as CreateResearchJobInput['outputFormat'],
    autoStart: input.autoStart !== false
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

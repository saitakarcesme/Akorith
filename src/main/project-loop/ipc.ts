import { dialog, ipcMain } from 'electron'
import { existsSync, mkdirSync, statSync } from 'fs'
import { basename, resolve } from 'path'
import {
  createLoop,
  getLoop,
  listLoops,
  updateLoop,
  setLoopStatus,
  archiveLoop,
  deleteLoop,
  type CreateLoopInput
} from './store'
import { listRuns } from './runs'
import { listEvents, logEvent } from './events'
import { listCommits } from './commits'
import { addBacklogItem, listBacklog, setBacklogStatus, updateBacklogItem } from './backlog'
import { addLoopMemory, listLoopMemories } from './memory'
import { runOneCycle } from './runner'
import { kickProjectLoopAutoScheduler } from './scheduler'
import type { BacklogItemStatus, ProjectLoopStatus } from './types'
import { runGoalToCompletion } from './goal'
import { isRepo } from './git'
import { cloneGitHubRepository } from './github'

const activeGoals = new Map<string, AbortController>()

// Phase 48: typed IPC surface for the project Loop. The renderer never touches
// the filesystem/DB directly — everything goes through these validated handlers.

export function registerProjectLoopIpc(): void {
  ipcMain.handle('projectLoop:list', () => listLoops())
  ipcMain.handle('projectLoop:runningIds', () => [...activeGoals.keys()])
  ipcMain.handle('projectLoop:get', (_e, id: string) => getLoop(id))

  ipcMain.handle('projectLoop:create', (_e, input: CreateLoopInput) => {
    if (!input || typeof input.title !== 'string' || typeof input.localPath !== 'string') {
      throw new Error('invalid loop input')
    }
    // For a from-scratch builder, make sure the target directory exists.
    if (input.mode === 'project_builder') {
      try {
        mkdirSync(input.localPath, { recursive: true })
      } catch {
        /* surfaced later by the runner if truly unwritable */
      }
    }
    const loop = createLoop(input)
    if (loop.autonomy === 'auto') kickProjectLoopAutoScheduler()
    return loop
  })

  ipcMain.handle('projectLoop:update', (_e, id: string, patch: Record<string, unknown>) => {
    const loop = updateLoop(id, patch)
    if (loop?.autonomy === 'auto' && loop.status === 'active') kickProjectLoopAutoScheduler()
    return loop
  })
  ipcMain.handle('projectLoop:setStatus', (_e, id: string, status: ProjectLoopStatus) => {
    const loop = setLoopStatus(id, status)
    if (loop?.autonomy === 'auto' && loop.status === 'active') kickProjectLoopAutoScheduler()
    return loop
  })
  ipcMain.handle('projectLoop:archive', (_e, id: string) => archiveLoop(id))
  ipcMain.handle('projectLoop:delete', (_e, id: string) => {
    activeGoals.get(id)?.abort()
    deleteLoop(id)
    return true
  })

  ipcMain.handle('projectLoop:runOnce', async (_e, id: string) => runOneCycle(id))
  ipcMain.handle('projectLoop:runGoal', async (_e, id: string) => {
    if (activeGoals.has(id)) throw new Error('goal is already running')
    const controller = new AbortController()
    activeGoals.set(id, controller)
    try {
      return await runGoalToCompletion(id, controller.signal)
    } finally {
      activeGoals.delete(id)
    }
  })
  ipcMain.handle('projectLoop:pauseGoal', (_e, id: string) => {
    activeGoals.get(id)?.abort()
    setLoopStatus(id, 'paused')
    logEvent(id, 'paused', 'Goal pause requested')
    return true
  })
  ipcMain.handle('projectLoop:editGoal', (_e, id: string, goal: string) => {
    if (typeof goal !== 'string' || !goal.trim() || goal.length > 20_000) throw new Error('invalid goal')
    const clean = goal.trim()
    const loop = updateLoop(id, {
      idea: clean,
      title: clean.replace(/\s+/g, ' ').slice(0, 80),
      roadmapSummary: undefined,
      memorySummary: undefined,
      error: undefined
    })
    const current = listBacklog(id).find((item) => item.status === 'open' || item.status === 'in_progress')
    if (current) updateBacklogItem(current.id, clean.replace(/\s+/g, ' ').slice(0, 160), clean)
    else addBacklogItem({ loopId: id, title: clean.replace(/\s+/g, ' ').slice(0, 160), detail: clean })
    logEvent(id, 'note', 'Goal updated by the user', clean.slice(0, 500))
    return loop
  })

  ipcMain.handle('projectLoop:listRuns', (_e, id: string) => listRuns(id))
  ipcMain.handle('projectLoop:listEvents', (_e, id: string) => listEvents(id))
  ipcMain.handle('projectLoop:listCommits', (_e, id: string) => listCommits(id))

  ipcMain.handle('projectLoop:listBacklog', (_e, id: string) => listBacklog(id))
  ipcMain.handle('projectLoop:addBacklog', (_e, id: string, title: string, detail?: string) =>
    addBacklogItem({ loopId: id, title, detail })
  )
  ipcMain.handle('projectLoop:setBacklogStatus', (_e, itemId: string, status: BacklogItemStatus) => {
    setBacklogStatus(itemId, status)
    return true
  })

  ipcMain.handle('projectLoop:listMemories', (_e, id: string) => listLoopMemories(id))
  ipcMain.handle('projectLoop:addMemory', (_e, id: string, content: string) => addLoopMemory(id, 'note', content))

  ipcMain.handle('projectLoop:cloneRepository', async (_event, input: unknown) => {
    if (typeof input !== 'string') throw new Error('invalid GitHub repository URL')
    return cloneGitHubRepository(input)
  })

  // Folder picker for choosing/importing a local project path.
  ipcMain.handle('projectLoop:pickFolder', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  })

  ipcMain.handle('projectLoop:inspectTarget', async (_event, input: unknown) => {
    if (typeof input !== 'string' || input.length === 0 || input.length > 4096) throw new Error('invalid target path')
    const path = resolve(input)
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error('The selected folder is not available.')
    return { path, name: basename(path), isRepo: await isRepo(path) }
  })
}

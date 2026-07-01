import { dialog, ipcMain } from 'electron'
import { mkdirSync } from 'fs'
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
import { listEvents } from './events'
import { listCommits } from './commits'
import { addBacklogItem, listBacklog, setBacklogStatus } from './backlog'
import { addLoopMemory, listLoopMemories } from './memory'
import { runOneCycle } from './runner'
import { kickProjectLoopAutoScheduler } from './scheduler'
import type { BacklogItemStatus, ProjectLoopStatus } from './types'

// Phase 48: typed IPC surface for the project Loop. The renderer never touches
// the filesystem/DB directly — everything goes through these validated handlers.

export function registerProjectLoopIpc(): void {
  ipcMain.handle('projectLoop:list', () => listLoops())
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
    deleteLoop(id)
    return true
  })

  ipcMain.handle('projectLoop:runOnce', async (_e, id: string) => runOneCycle(id))

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

  // Folder picker for choosing/importing a local project path.
  ipcMain.handle('projectLoop:pickFolder', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  })
}

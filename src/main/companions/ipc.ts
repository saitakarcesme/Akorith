import { ipcMain } from 'electron'
import { listCompanions, getCompanion, setCompanionModel } from './store'
import { createSession, getSession, listSessions, deleteSession } from './sessions'
import { listMessages } from './messages'
import { sendCompanionMessage, getCompanionContextInfo } from './chat'
import { extractMemoriesFromSession } from './extract'
import {
  listMemories,
  searchMemories,
  createMemory,
  updateMemory,
  archiveMemory,
  forgetMemory,
  pinMemory,
  countMemories,
  type CreateMemoryInput
} from './memories'
import type { CompanionMemoryType } from './types'

// Phase 50: typed IPC for Companions. Companions never act — these are chat +
// memory operations only.

export function registerCompanionIpc(): void {
  ipcMain.handle('companion:list', () => listCompanions())
  ipcMain.handle('companion:get', (_e, id: string) => getCompanion(id))
  ipcMain.handle('companion:setModel', (_e, id: string, model: string | null) => setCompanionModel(id, model || null))
  ipcMain.handle('companion:memoryCount', (_e, id: string) => countMemories(id))

  ipcMain.handle('companion:listSessions', (_e, companionId: string) => listSessions(companionId))
  ipcMain.handle('companion:createSession', (_e, companionId: string, title?: string) => createSession(companionId, title))
  ipcMain.handle('companion:getSession', (_e, id: string) => getSession(id))
  ipcMain.handle('companion:deleteSession', (_e, id: string) => {
    deleteSession(id)
    return true
  })
  ipcMain.handle('companion:listMessages', (_e, sessionId: string) => listMessages(sessionId))

  ipcMain.handle('companion:sendMessage', async (_e, input: unknown) => {
    const i = (input ?? {}) as { companionId?: string; sessionId?: string; prompt?: string; model?: string }
    if (!i.companionId || !i.sessionId || typeof i.prompt !== 'string') {
      return { ok: false, error: 'invalid message input' }
    }
    return sendCompanionMessage({ companionId: i.companionId, sessionId: i.sessionId, prompt: i.prompt, model: i.model })
  })

  ipcMain.handle('companion:extractMemories', async (_e, sessionId: string) => extractMemoriesFromSession(sessionId))
  ipcMain.handle('companion:contextInfo', (_e, companionId: string, sessionId: string, query: string) =>
    getCompanionContextInfo(companionId, sessionId, query ?? '')
  )

  ipcMain.handle('companion:listMemories', (_e, companionId: string, includeArchived?: boolean) =>
    listMemories(companionId, { includeArchived: includeArchived === true })
  )
  ipcMain.handle('companion:searchMemories', (_e, companionId: string, query: string) => searchMemories(companionId, query))
  ipcMain.handle('companion:createMemory', (_e, input: unknown) => {
    const i = (input ?? {}) as Partial<CreateMemoryInput>
    if (!i.companionId || !i.type || !i.title || !i.content) throw new Error('invalid memory input')
    return createMemory({
      companionId: i.companionId,
      type: i.type as CompanionMemoryType,
      title: i.title,
      content: i.content,
      importance: i.importance,
      tags: i.tags
    })
  })
  ipcMain.handle('companion:updateMemory', (_e, id: string, patch: Record<string, unknown>) => updateMemory(id, patch))
  ipcMain.handle('companion:pinMemory', (_e, id: string, pinned: boolean) => pinMemory(id, pinned === true))
  ipcMain.handle('companion:archiveMemory', (_e, id: string) => archiveMemory(id))
  ipcMain.handle('companion:forgetMemory', (_e, id: string) => {
    forgetMemory(id)
    return true
  })
}

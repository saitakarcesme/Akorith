import {
  countStartupRows,
  resolveStartupRestore,
  type StartupProjectLike,
  type StartupSessionLike
} from '../src/main/startupSnapshotCore'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const projects: StartupProjectLike[] = [{ id: 'project-a' }, { id: 'project-b' }]
const sessions: StartupSessionLike[] = [
  { id: 'chat-project-a-newest', projectId: 'project-a' },
  { id: 'chat-general', projectId: null },
  { id: 'chat-orphan', projectId: 'removed-project' },
  { id: 'chat-project-b', projectId: 'project-b' }
]

const counts = countStartupRows(projects, sessions)
assert(counts.projects === 2, 'counts persisted projects')
assert(counts.chats === 4, 'counts all chats')
assert(counts.projectChats === 2, 'counts project chats')
assert(counts.generalChats === 2, 'counts general plus orphan chats')
assert(counts.orphanChats === 1, 'counts orphan chats separately')

const restoredProjectChat = resolveStartupRestore(projects, sessions, {
  lastActiveProjectId: 'project-b',
  lastActiveSessionId: 'chat-project-b',
  lastView: 'workspace'
})
assert(restoredProjectChat.view === 'workspace', 'restores project chat into workspace')
assert(restoredProjectChat.projectId === 'project-b', 'restores project id from active chat')
assert(restoredProjectChat.sessionId === 'chat-project-b', 'restores active project chat id')

const restoredOrphan = resolveStartupRestore(projects, sessions, {
  lastActiveSessionId: 'chat-orphan',
  lastView: 'workspace'
})
assert(restoredOrphan.view === 'general', 'restores orphan chat as general')
assert(restoredOrphan.projectId === null, 'orphan chat does not restore removed project')
assert(restoredOrphan.sessionId === 'chat-orphan', 'restores orphan chat id')

const restoredProject = resolveStartupRestore(projects, sessions, {
  lastActiveProjectId: 'project-b',
  lastActiveSessionId: 'missing-chat'
})
assert(restoredProject.view === 'workspace', 'falls back to last project')
assert(restoredProject.projectId === 'project-b', 'keeps valid last project')
assert(restoredProject.sessionId === 'chat-project-b', 'uses latest chat inside last project')

const restoredLatest = resolveStartupRestore(projects, sessions, {
  lastActiveProjectId: 'missing-project',
  lastActiveSessionId: 'missing-chat'
})
assert(restoredLatest.sessionId === 'chat-project-a-newest', 'falls back to latest chat')

const restoredEmpty = resolveStartupRestore([], [], { lastView: 'plugins' })
assert(restoredEmpty.view === 'plugins', 'restores non-chat view when no data exists')
assert(restoredEmpty.projectId === null && restoredEmpty.sessionId === null, 'empty snapshot stays empty')

const restoredResearch = resolveStartupRestore(projects, sessions, {
  lastActiveProjectId: 'project-b',
  lastActiveSessionId: 'chat-project-b',
  lastView: 'research'
})
assert(restoredResearch.view === 'research', 'restores Research before stale chat state')
assert(restoredResearch.projectId === null && restoredResearch.sessionId === null, 'Research owns its internal selection')

console.log('startup hydration verifier passed')

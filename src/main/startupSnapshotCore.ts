export type StartupView = 'workspace' | 'general' | 'dashboard' | 'test' | 'loops' | 'plugins'

export interface StartupProjectLike {
  id: string
}

export interface StartupSessionLike {
  id: string
  projectId: string | null
}

export interface StartupRestoreRequest {
  lastActiveProjectId?: unknown
  lastActiveSessionId?: unknown
  lastView?: unknown
  sidebarWidth?: unknown
  displayName?: unknown
}

export interface StartupRestoreTarget {
  view: StartupView
  projectId: string | null
  sessionId: string | null
  reason: string
}

export interface StartupHydrationCounts {
  projects: number
  chats: number
  projectChats: number
  generalChats: number
  orphanChats: number
}

const VALID_ID = /^[\w-]{1,64}$/
const VALID_VIEWS = new Set<StartupView>(['workspace', 'general', 'dashboard', 'test', 'loops', 'plugins'])

function cleanId(value: unknown): string | null {
  return typeof value === 'string' && VALID_ID.test(value) ? value : null
}

export function cleanStartupView(value: unknown): StartupView {
  return typeof value === 'string' && VALID_VIEWS.has(value as StartupView) ? (value as StartupView) : 'workspace'
}

export function cleanSidebarWidth(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n >= 220 && n <= 720 ? Math.round(n) : null
}

export function cleanDisplayName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().slice(0, 80)
  return trimmed || null
}

export function countStartupRows(
  projects: StartupProjectLike[],
  sessions: StartupSessionLike[]
): StartupHydrationCounts {
  const projectIds = new Set(projects.map((project) => project.id))
  let projectChats = 0
  let generalChats = 0
  let orphanChats = 0
  for (const session of sessions) {
    if (!session.projectId) {
      generalChats += 1
    } else if (projectIds.has(session.projectId)) {
      projectChats += 1
    } else {
      orphanChats += 1
      generalChats += 1
    }
  }
  return {
    projects: projects.length,
    chats: sessions.length,
    projectChats,
    generalChats,
    orphanChats
  }
}

export function resolveStartupRestore(
  projects: StartupProjectLike[],
  sessions: StartupSessionLike[],
  request: StartupRestoreRequest = {}
): StartupRestoreTarget {
  const projectIds = new Set(projects.map((project) => project.id))
  const sessionById = new Map(sessions.map((session) => [session.id, session]))
  const lastSessionId = cleanId(request.lastActiveSessionId)
  const lastProjectId = cleanId(request.lastActiveProjectId)
  const lastView = cleanStartupView(request.lastView)

  const lastSession = lastSessionId ? sessionById.get(lastSessionId) ?? null : null
  if (lastSession) {
    if (lastSession.projectId && projectIds.has(lastSession.projectId)) {
      return {
        view: 'workspace',
        projectId: lastSession.projectId,
        sessionId: lastSession.id,
        reason: 'last-active-session'
      }
    }
    return {
      view: 'general',
      projectId: null,
      sessionId: lastSession.id,
      reason: lastSession.projectId ? 'last-active-orphan-session' : 'last-active-session'
    }
  }

  if (lastProjectId && projectIds.has(lastProjectId)) {
    const projectSession = sessions.find((session) => session.projectId === lastProjectId) ?? null
    return {
      view: 'workspace',
      projectId: lastProjectId,
      sessionId: projectSession?.id ?? null,
      reason: projectSession ? 'last-active-project-latest-chat' : 'last-active-project'
    }
  }

  if (lastView === 'general') {
    const generalSession = sessions.find((session) => !session.projectId || !projectIds.has(session.projectId)) ?? null
    return {
      view: 'general',
      projectId: null,
      sessionId: generalSession?.id ?? null,
      reason: generalSession ? 'last-view-general-latest-chat' : 'last-view-general'
    }
  }

  const latestSession = sessions[0] ?? null
  if (latestSession) {
    if (latestSession.projectId && projectIds.has(latestSession.projectId)) {
      return {
        view: 'workspace',
        projectId: latestSession.projectId,
        sessionId: latestSession.id,
        reason: 'latest-chat'
      }
    }
    return {
      view: 'general',
      projectId: null,
      sessionId: latestSession.id,
      reason: latestSession.projectId ? 'latest-orphan-chat' : 'latest-chat'
    }
  }

  if (lastView !== 'workspace') {
    return { view: lastView, projectId: null, sessionId: null, reason: 'last-view' }
  }

  return {
    view: 'workspace',
    projectId: projects[0]?.id ?? null,
    sessionId: null,
    reason: projects[0] ? 'latest-project' : 'empty-workspace'
  }
}

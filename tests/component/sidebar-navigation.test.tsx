import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StartupSnapshot } from '../../src/preload/index.d'
import Sidebar from '../../src/renderer/src/components/Sidebar'

const stylesheet = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/styles.css'),
  'utf8'
)

const startupSnapshot: StartupSnapshot = {
  app: {
    name: 'Akorith',
    userDataPath: 'C:\\Akorith',
    dbPath: 'C:\\Akorith\\akorith.db',
    configPath: 'C:\\Akorith\\akorith.config.json'
  },
  settings: {
    theme: 'dark',
    bridge: { autoEnter: false },
    digest: { enabled: false, workingDir: 'C:\\Projects\\Atlas' },
    router: { classifierModel: '', tierProviders: {} },
    providers: []
  },
  preferences: { displayName: 'Ibrahim', sidebarWidth: 292, lastView: 'workspace' },
  projects: [{
    id: 'project-atlas',
    name: 'Atlas project with a deliberately long name',
    path: 'C:\\Projects\\Atlas',
    color: null,
    icon: null,
    createdAt: 1,
    updatedAt: 2
  }],
  sessions: [{
    id: 'chat-atlas',
    providerId: 'chatgpt',
    title: 'A deliberately long project chat title',
    projectId: 'project-atlas',
    createdAt: 1,
    updatedAt: 2
  }],
  restore: {
    view: 'workspace',
    projectId: 'project-atlas',
    sessionId: 'chat-atlas',
    reason: 'Component test'
  },
  diagnostics: {
    dbReady: true,
    configReady: true,
    loadedAt: 3,
    counts: { projects: 1, chats: 1, projectChats: 1, generalChats: 0, orphanChats: 0 },
    warnings: [],
    migration: { attempted: false, copied: [], skipped: [], warnings: [], candidates: [] }
  }
}

function renderSidebar(onNavigate = vi.fn()): void {
  render(
    <Sidebar
      view="workspace"
      theme="dark"
      onThemeChange={vi.fn()}
      onNavigate={onNavigate}
      historyVersion={0}
      projectVersion={0}
      startupSnapshot={startupSnapshot}
      startupHydrated
      startupError={null}
      onRetryStartupHydration={vi.fn()}
      activeSessionId={null}
      activeProject={startupSnapshot.projects[0]}
      onSelectProject={vi.fn()}
      onSelectSession={vi.fn()}
      onNewChat={vi.fn()}
      onNewGeneralChat={vi.fn()}
      onNewProjectChat={vi.fn()}
      onHistoryChange={vi.fn()}
      onProjectsChange={vi.fn()}
    />
  )
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('akorith.expandedProjects', JSON.stringify({ 'project-atlas': true }))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      chat: { listProviders: vi.fn().mockResolvedValue([]) },
      history: { list: vi.fn().mockResolvedValue(startupSnapshot.sessions) },
      projects: { list: vi.fn().mockResolvedValue(startupSnapshot.projects) }
    }
  })
})

describe('Sidebar navigation and tree alignment', () => {
  it('keeps only Loop, Benchmark, and Plugins in More and restores trigger focus on Escape', async () => {
    const onNavigate = vi.fn()
    const user = userEvent.setup()
    renderSidebar(onNavigate)

    const more = screen.getByRole('button', { name: 'More' })
    await user.click(more)
    const menu = screen.getByRole('menu', { name: 'More destinations' })
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Loop',
      'Benchmark',
      'Plugins'
    ])
    expect(screen.queryByText('Companions')).not.toBeInTheDocument()
    expect(screen.queryByText('Agents')).not.toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu', { name: 'More destinations' })).not.toBeInTheDocument()
    expect(more).toHaveFocus()

    await user.click(more)
    await user.click(screen.getByRole('menuitem', { name: 'Benchmark' }))
    expect(onNavigate).toHaveBeenCalledWith('test')
  })

  it('uses one computed content inset for project and nested chat labels', async () => {
    renderSidebar()

    const projectLabel = await screen.findByText('Atlas project with a deliberately long name')
    const chatLabel = await screen.findByText('A deliberately long project chat title')
    const projectRow = projectLabel.closest('.project-row')
    const chatGroup = chatLabel.closest('.project-chats')
    const chatRow = chatLabel.closest('.project-chat')
    const disclosure = projectRow?.querySelector('.project-disclosure')

    expect(projectLabel).toHaveAttribute('data-sidebar-content-anchor', 'project-label')
    expect(chatLabel).toHaveAttribute('data-sidebar-content-anchor', 'chat-label')
    expect(projectRow).not.toBeNull()
    expect(chatGroup).not.toBeNull()
    expect(chatRow).not.toBeNull()
    expect(disclosure).not.toBeNull()

    await waitFor(() => expect(projectRow).toBeInTheDocument())
    expect(stylesheet).toMatch(/\.project-row\s*\{[\s\S]*?padding:\s*4px 6px 4px var\(--sidebar-tree-content-inset\)/)
    expect(stylesheet).toMatch(/\.project-chats\s*\{[\s\S]*?padding-left:\s*var\(--sidebar-tree-content-inset\)/)
    expect(stylesheet).toMatch(/\.project-chat\s*\{[\s\S]*?padding-left:\s*0/)
    expect(stylesheet).toMatch(/\.project-disclosure\s*\{[\s\S]*?position:\s*absolute/)
  })
})

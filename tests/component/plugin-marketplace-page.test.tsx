import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { MARKETPLACE_PLUGINS } from '../../src/main/plugin-marketplace/catalog'
import PluginMarketplacePage, {
  type PluginMarketplaceApi
} from '../../src/renderer/src/components/PluginMarketplacePage'

function manifest(id: string) {
  const match = MARKETPLACE_PLUGINS.find((plugin) => plugin.id === id)
  if (!match) throw new Error(`Missing test manifest: ${id}`)
  return match
}

describe('plugin marketplace page', () => {
  it('renders the exact 30-plugin catalog and filters by search and category', async () => {
    const user = userEvent.setup()
    render(<PluginMarketplacePage initialPlugins={MARKETPLACE_PLUGINS} />)

    expect(screen.getAllByRole('article')).toHaveLength(30)
    expect(screen.getByText('30', { selector: 'strong' })).toBeInTheDocument()

    await user.type(screen.getByRole('searchbox', { name: 'Search plugins' }), 'GitHub')
    expect(screen.getAllByRole('article')).toHaveLength(1)
    expect(screen.getByRole('heading', { name: 'GitHub' })).toBeInTheDocument()

    await user.clear(screen.getByRole('searchbox', { name: 'Search plugins' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Category' }), 'source-control')
    expect(screen.getAllByRole('article')).toHaveLength(3)
    expect(screen.getByRole('heading', { name: 'GitLab' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Bitbucket' })).toBeInTheDocument()
  })

  it('shows only supported lifecycle controls and never infers a connected state', async () => {
    const user = userEvent.setup()
    const github = manifest('github')
    const enabledDisconnected = {
      manifest: github,
      installation: {
        pluginId: github.id,
        state: 'enabled',
        installedVersion: github.version,
        lastError: null
      },
      connection: {
        pluginId: github.id,
        state: 'disconnected',
        reason: 'Sign in to GitHub to verify this connection.',
        checkedAt: null
      }
    }
    const connected = {
      ...enabledDisconnected,
      connection: {
        pluginId: github.id,
        state: 'connected',
        reason: 'Verified by the GitHub adapter.',
        checkedAt: Date.now()
      }
    }
    const connect = vi.fn().mockResolvedValue([connected])
    const disable = vi.fn().mockResolvedValue([{
      ...enabledDisconnected,
      installation: { ...enabledDisconnected.installation, state: 'disabled' }
    }])
    const configure = vi.fn().mockResolvedValue(undefined)
    const uninstall = vi.fn().mockResolvedValue(undefined)
    const api: PluginMarketplaceApi = {
      list: vi.fn().mockResolvedValue([enabledDisconnected]),
      connect,
      disable,
      configure,
      uninstall
    }

    render(<PluginMarketplacePage api={api} initialPlugins={[enabledDisconnected]} />)

    expect(screen.getByText('Auth required')).toBeInTheDocument()
    expect(screen.queryByText('Connected')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Disable' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Configure' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Uninstall' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Enable' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Connect' }))
    expect(connect).toHaveBeenCalledWith('github')
    expect(await screen.findByText('Connected')).toBeInTheDocument()

    const reviewAccess = screen.getByRole('button', { name: 'Review access' })
    reviewAccess.focus()
    await user.keyboard('{Enter}')
    const disclosure = screen.getByText('Permission disclosure').closest('.plugin-marketplace-details')
    expect(disclosure).not.toBeNull()
    expect(within(disclosure as HTMLElement).getByText('https://api.github.com')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hide access' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('keeps unavailable operations absent and reports catalog failures honestly', async () => {
    const api: PluginMarketplaceApi = {
      list: vi.fn().mockRejectedValue(new Error('Plugin service is offline'))
    }
    render(<PluginMarketplacePage api={api} />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Plugin service is offline')
    expect(screen.queryByText('Connected')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument()

    await waitFor(() => expect(api.list).toHaveBeenCalledOnce())
  })
})

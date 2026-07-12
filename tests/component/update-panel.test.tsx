import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PackagedUpdateSnapshot, UpdateApi } from '../../src/preload/index.d'
import UpdatePanel from '../../src/renderer/src/components/UpdatePanel'

function snapshot(overrides: Partial<PackagedUpdateSnapshot> = {}): PackagedUpdateSnapshot {
  return {
    phase: 'idle',
    channel: 'stable',
    currentVersion: '1.0.0',
    support: { supported: true, code: 'SUPPORTED', reason: 'Packaged updater is available.' },
    updatedAt: 1,
    canCheck: true,
    canDownload: false,
    canAuthorizeInstall: false,
    manualInstallRequired: true,
    ...overrides
  }
}

function installApi(api: UpdateApi): void {
  Object.defineProperty(window, 'api', { configurable: true, value: { update: api } })
}

beforeEach(() => {
  installApi({
    status: vi.fn().mockResolvedValue(snapshot()),
    settings: vi.fn().mockResolvedValue({ automaticChecks: true, channel: 'stable' }),
    setSettings: vi.fn().mockResolvedValue({ automaticChecks: true, channel: 'stable' }),
    check: vi.fn().mockResolvedValue(snapshot({ phase: 'not-available', checkedAt: 20 })),
    download: vi.fn().mockResolvedValue(snapshot()),
    authorizeInstall: vi.fn().mockResolvedValue(null),
    install: vi.fn().mockResolvedValue(snapshot()),
    onChanged: vi.fn().mockReturnValue(() => undefined)
  })
})

describe('UpdatePanel', () => {
  it('loads packaged status and runs a manual update check', async () => {
    const user = userEvent.setup()
    render(<UpdatePanel />)

    expect(await screen.findByText('1.0.0')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Check now' }))
    expect(window.api.update.check).toHaveBeenCalledWith('stable')
    expect(await screen.findByText('Akorith is up to date.')).toBeInTheDocument()
  })

  it('requires one-use install authorization before restart and install', async () => {
    const install = vi.fn().mockResolvedValue(snapshot({ phase: 'installing' }))
    const authorizeInstall = vi.fn().mockResolvedValue({ token: 'one-use', expiresAt: 100, version: '1.1.0' })
    installApi({
      status: vi.fn().mockResolvedValue(snapshot({
        phase: 'downloaded', canAuthorizeInstall: true,
        update: { version: '1.1.0', releaseName: 'Akorith 1.1.0', prerelease: false }
      })),
      settings: vi.fn().mockResolvedValue({ automaticChecks: true, channel: 'stable' }),
      setSettings: vi.fn().mockResolvedValue({ automaticChecks: true, channel: 'stable' }),
      check: vi.fn(), download: vi.fn(), authorizeInstall, install,
      onChanged: vi.fn().mockReturnValue(() => undefined)
    })
    const user = userEvent.setup()
    render(<UpdatePanel />)

    await user.click(await screen.findByRole('button', { name: 'Restart and install' }))
    await waitFor(() => expect(authorizeInstall).toHaveBeenCalledTimes(1))
    expect(install).toHaveBeenCalledWith('one-use')
  })

  it('states honestly when this packaged form cannot self-update', async () => {
    installApi({
      status: vi.fn().mockResolvedValue(snapshot({
        phase: 'unsupported', canCheck: false,
        support: { supported: false, code: 'PORTABLE_BUILD', reason: 'Portable builds do not self-update.' }
      })),
      settings: vi.fn().mockResolvedValue({ automaticChecks: false, channel: 'stable' }),
      setSettings: vi.fn(), check: vi.fn(), download: vi.fn(), authorizeInstall: vi.fn(), install: vi.fn(),
      onChanged: vi.fn().mockReturnValue(() => undefined)
    })
    render(<UpdatePanel />)

    expect(await screen.findByText('Portable builds do not self-update.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check now' })).toBeDisabled()
  })
})

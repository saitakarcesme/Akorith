import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import RemoteNodesPanel from '../../src/renderer/src/components/RemoteNodesPanel'
import type { RemoteNodesApi, RemoteNodeView } from '../../src/preload/index.d'

const node: RemoteNodeView = {
  id: 'node-rtx', nodeId: 'node-rtx', name: 'RTX 3090 PC', baseUrl: 'https://rtx.tailnet.test:47841',
  protocolVersion: '1.0', deviceId: 'client-mac', deviceName: 'MacBook Air', createdAt: 1, updatedAt: 2,
  privateLanHttpAcknowledged: false,
  connection: { phase: 'online', consecutiveFailures: 0, lastHealthyAt: Date.now(), latencyMs: 18 }
}

function api(list = vi.fn(async () => [node])): RemoteNodesApi {
  return {
    list,
    pair: vi.fn(async () => ({})),
    test: vi.fn(async () => ({})),
    catalog: vi.fn(async () => ({ models: [{ id: 'qwen' }] })),
    revoke: vi.fn(async () => true),
    onChanged: vi.fn(() => () => undefined)
  }
}

describe('RemoteNodesPanel', () => {
  it('shows an honest unavailable state without the bridge', () => {
    render(<RemoteNodesPanel api={null} />)
    expect(screen.getByText('Remote compute unavailable')).toBeInTheDocument()
  })

  it('renders measured node health and invokes live controls', async () => {
    const service = api()
    render(<RemoteNodesPanel api={service} />)
    expect(await screen.findByText('RTX 3090 PC')).toBeInTheDocument()
    expect(screen.getByText('18 ms')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Test' }))
    await waitFor(() => expect(service.test).toHaveBeenCalledWith('node-rtx'))
    expect(await screen.findByText(/responded to an authenticated health check/i)).toBeInTheDocument()
  })

  it('requires pairing fields and forwards explicit LAN acknowledgement', async () => {
    const service = api(vi.fn(async () => []))
    render(<RemoteNodesPanel api={service} />)
    const pair = screen.getByRole('button', { name: 'Pair node' })
    expect(pair).toBeDisabled()
    fireEvent.change(screen.getByPlaceholderText('https://rtx-pc.tailnet.ts.net:47841'), { target: { value: 'http://192.168.1.20:47841' } })
    fireEvent.change(screen.getByText('Pairing id').nextSibling as Element, { target: { value: 'pair-1' } })
    fireEvent.change(screen.getByText('Short-lived code').nextSibling as Element, { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(pair)
    await waitFor(() => expect(service.pair).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: 'http://192.168.1.20:47841', pairingId: 'pair-1', code: '123456', acknowledgePrivateLanHttp: true
    })))
  })
})

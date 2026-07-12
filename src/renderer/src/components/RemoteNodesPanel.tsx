import { useCallback, useEffect, useState } from 'react'
import type { PairRemoteNodeInputView, RemoteNodesApi, RemoteNodeView } from '../../../preload/index.d'
import './remote-nodes.css'

export interface RemoteNodesPanelProps {
  api?: RemoteNodesApi | null
}

function defaultApi(): RemoteNodesApi | null {
  return typeof window !== 'undefined' && window.api?.remoteNodes ? window.api.remoteNodes : null
}

function relative(timestamp?: number): string {
  if (!timestamp) return 'Never'
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000))
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  return new Date(timestamp).toLocaleString()
}

export default function RemoteNodesPanel({ api: suppliedApi }: RemoteNodesPanelProps): JSX.Element {
  const api = suppliedApi === undefined ? defaultApi() : suppliedApi
  const [nodes, setNodes] = useState<RemoteNodeView[]>([])
  const [loading, setLoading] = useState(Boolean(api))
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [form, setForm] = useState<PairRemoteNodeInputView>({
    baseUrl: '', pairingId: '', code: '', deviceName: 'Akorith desktop'
  })

  const load = useCallback(async (): Promise<void> => {
    if (!api) { setLoading(false); return }
    setLoading(true)
    try { setNodes(await api.list()); setError(null) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Remote nodes could not be loaded.') }
    finally { setLoading(false) }
  }, [api])

  useEffect(() => {
    void load()
    return api?.onChanged(() => void load())
  }, [api, load])

  const pair = async (): Promise<void> => {
    if (!api) return
    setBusy('pair'); setError(null); setNotice(null)
    try {
      await api.pair(form)
      setNotice('Node paired. Its protected device token was stored by the operating system.')
      setForm((current) => ({ ...current, pairingId: '', code: '' }))
      await load()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Pairing failed.') }
    finally { setBusy(null) }
  }

  const action = async (node: RemoteNodeView, kind: 'test' | 'catalog' | 'revoke'): Promise<void> => {
    if (!api) return
    setBusy(`${kind}:${node.id}`); setError(null); setNotice(null)
    try {
      if (kind === 'test') { await api.test(node.id); setNotice(`${node.name} responded to an authenticated health check.`) }
      if (kind === 'catalog') {
        const result = await api.catalog(node.id, true) as { models?: unknown[] }
        setNotice(`${node.name} reported ${Array.isArray(result.models) ? result.models.length : 0} model(s).`)
      }
      if (kind === 'revoke') { await api.revoke(node.id); setNotice(`${node.name} was revoked on this device.`) }
      await load()
    } catch (cause) { setError(cause instanceof Error ? cause.message : `${kind} failed.`) }
    finally { setBusy(null) }
  }

  if (!api) return <div className="remote-node-empty"><strong>Remote compute unavailable</strong><span>The secure remote-node bridge is not present in this build.</span></div>

  return (
    <div className="remote-nodes-panel">
      <div className="remote-node-intro">
        <div><h3>Remote Nodes</h3><p>Pair an Akorith Node over HTTPS, Tailscale, or an acknowledged private LAN.</p></div>
        <button type="button" onClick={() => void load()} disabled={loading}>Refresh</button>
      </div>
      <div className="remote-node-warning">Remote inference is authenticated. Project files and coding tools stay on this device unless a future remote-workspace mode is explicitly selected.</div>
      <div className="remote-node-pair-grid">
        <label><span>Node address</span><input value={form.baseUrl} placeholder="https://rtx-pc.tailnet.ts.net:47841" onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} /></label>
        <label><span>Pairing id</span><input value={form.pairingId} onChange={(event) => setForm({ ...form, pairingId: event.target.value })} /></label>
        <label><span>Short-lived code</span><input value={form.code} autoComplete="one-time-code" onChange={(event) => setForm({ ...form, code: event.target.value })} /></label>
        <label><span>This device name</span><input value={form.deviceName} onChange={(event) => setForm({ ...form, deviceName: event.target.value })} /></label>
      </div>
      <label className="remote-node-ack"><input type="checkbox" checked={form.acknowledgePrivateLanHttp === true} onChange={(event) => setForm({ ...form, acknowledgePrivateLanHttp: event.target.checked })} /><span>Allow plaintext HTTP only when this is a trusted, private LAN address. Public HTTP remains blocked.</span></label>
      <button className="remote-node-pair" type="button" disabled={busy !== null || !form.baseUrl.trim() || !form.pairingId.trim() || !form.code.trim() || !form.deviceName.trim()} onClick={() => void pair()}>{busy === 'pair' ? 'Pairing…' : 'Pair node'}</button>
      {error && <div className="remote-node-message is-error" role="alert">{error}</div>}
      {notice && <div className="remote-node-message is-success" role="status">{notice}</div>}
      <div className="remote-node-list" aria-busy={loading}>
        {!loading && nodes.length === 0 && <div className="remote-node-empty"><strong>No paired nodes</strong><span>Run the Akorith Node daemon on the model host, then enter its displayed pairing id and code.</span></div>}
        {nodes.map((node) => (
          <article className="remote-node-card" key={node.id}>
            <div className="remote-node-card-head"><div><strong>{node.name}</strong><code>{node.baseUrl}</code></div><span className={`is-${node.connection.phase}`}>{node.connection.phase}</span></div>
            <dl><div><dt>Latency</dt><dd>{node.connection.latencyMs === undefined ? 'Unavailable' : `${node.connection.latencyMs} ms`}</dd></div><div><dt>Last seen</dt><dd>{relative(node.connection.lastHealthyAt)}</dd></div><div><dt>Protocol</dt><dd>{node.protocolVersion}</dd></div></dl>
            {node.connection.error && <p className="remote-node-error">{node.connection.error}</p>}
            <div className="remote-node-actions"><button type="button" disabled={busy !== null} onClick={() => void action(node, 'test')}>Test</button><button type="button" disabled={busy !== null} onClick={() => void action(node, 'catalog')}>Refresh models</button><button type="button" className="is-danger" disabled={busy !== null} onClick={() => void action(node, 'revoke')}>Revoke</button></div>
          </article>
        ))}
      </div>
    </div>
  )
}

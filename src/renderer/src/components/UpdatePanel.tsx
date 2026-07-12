import { useCallback, useEffect, useState } from 'react'
import type { PackagedUpdateSnapshot, UpdateChannel, UpdateSettingsView } from '../../../preload/index.d'

function timestamp(value?: number): string {
  return value ? new Date(value).toLocaleString() : 'Not checked yet'
}

function bytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 ** 2).toFixed(1)} MB`
}

export default function UpdatePanel(): JSX.Element {
  const [snapshot, setSnapshot] = useState<PackagedUpdateSnapshot | null>(null)
  const [settings, setSettings] = useState<UpdateSettingsView | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    const [nextSnapshot, nextSettings] = await Promise.all([
      window.api.update.status(),
      window.api.update.settings()
    ])
    setSnapshot(nextSnapshot)
    setSettings(nextSettings)
  }, [])

  useEffect(() => {
    void load().catch((error) => setNotice(error instanceof Error ? error.message : String(error)))
    return window.api.update.onChanged(setSnapshot)
  }, [load])

  const setPreference = async (patch: Partial<UpdateSettingsView>): Promise<void> => {
    const next = await window.api.update.setSettings(patch)
    setSettings(next)
  }

  const check = async (): Promise<void> => {
    setBusy(true)
    setNotice(null)
    try {
      const next = await window.api.update.check(settings?.channel)
      setSnapshot(next)
      if (next.phase === 'not-available') setNotice('Akorith is up to date.')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const download = async (): Promise<void> => {
    setBusy(true)
    setNotice(null)
    try { setSnapshot(await window.api.update.download()) }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  const install = async (): Promise<void> => {
    setBusy(true)
    setNotice(null)
    try {
      const authorization = await window.api.update.authorizeInstall()
      if (!authorization) {
        setNotice('The downloaded update is no longer ready to install. Check again.')
        return
      }
      setSnapshot(await window.api.update.install(authorization.token))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="settings-section" aria-labelledby="updates-heading">
      <div className="settings-section-head">
        <div>
          <h2 id="updates-heading">Updates</h2>
          <p>Install signed Akorith releases from GitHub. Installed apps never pull or execute source repository commands.</p>
        </div>
        <button type="button" disabled={busy || !snapshot?.canCheck} onClick={() => void check()}>
          {snapshot?.phase === 'checking' ? 'Checking…' : 'Check now'}
        </button>
      </div>

      {!snapshot || !settings ? (
        <div className="settings-hint">Loading packaged update status…</div>
      ) : (
        <>
          <div className="ctrl-grid">
            <div className="ctrl-field"><span>Current version</span><code>{snapshot.currentVersion}</code></div>
            <div className="ctrl-field"><span>Channel</span><code>{settings.channel}</code></div>
            <div className="ctrl-field"><span>Last checked</span><code>{timestamp(snapshot.checkedAt)}</code></div>
            <div className="ctrl-field"><span>Status</span><code>{snapshot.phase.replace('-', ' ')}</code></div>
          </div>

          <div className="settings-checks">
            <label>
              <input
                type="checkbox"
                checked={settings.automaticChecks}
                onChange={(event) => void setPreference({ automaticChecks: event.target.checked })}
              />
              <span>Check automatically after startup</span>
            </label>
            <label>
              <span>Update channel</span>
              <select
                value={settings.channel}
                onChange={(event) => void setPreference({ channel: event.target.value as UpdateChannel })}
              >
                <option value="stable">Stable</option>
                <option value="beta">Beta / prerelease</option>
              </select>
            </label>
          </div>

          {!snapshot.support.supported && (
            <div className="ollama-status is-info">{snapshot.support.reason}</div>
          )}
          {snapshot.error && (
            <div className="ollama-status is-error">{snapshot.error.message}</div>
          )}
          {notice && <div className="ollama-status is-info">{notice}</div>}

          {snapshot.update && (
            <div className="update-packaged">
              <div className="update-log-cmd">
                <strong>{snapshot.update.releaseName || `Akorith ${snapshot.update.version}`}</strong>
                <code>{snapshot.update.prerelease ? 'prerelease' : 'stable'}</code>
              </div>
              {snapshot.update.releaseNotes && <div className="settings-note">{snapshot.update.releaseNotes}</div>}
            </div>
          )}

          {snapshot.progress && (
            <div className="update-progress" aria-label={`Download ${snapshot.progress.percent.toFixed(0)} percent`}>
              <div className="update-progress-track"><span style={{ width: `${snapshot.progress.percent}%` }} /></div>
              <span>{snapshot.progress.percent.toFixed(0)}% · {bytes(snapshot.progress.transferred)} of {bytes(snapshot.progress.total)}</span>
            </div>
          )}

          <div className="settings-action-row">
            {snapshot.canDownload && (
              <button type="button" className="is-primary" disabled={busy} onClick={() => void download()}>
                Download update
              </button>
            )}
            {snapshot.canAuthorizeInstall && (
              <button type="button" className="is-primary" disabled={busy} onClick={() => void install()}>
                Restart and install
              </button>
            )}
          </div>

          <div className="settings-note">
            Downloads never install automatically. “Restart and install” creates a short-lived, one-use authorization for this exact release.
          </div>
        </>
      )}
    </section>
  )
}

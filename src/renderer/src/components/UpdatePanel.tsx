import { useCallback, useEffect, useState } from 'react'
import type { UpdateLogEntry, UpdateRunResult, UpdateStatus } from '../../../preload/index.d'

// Phase 39: Settings → Update. A safe source updater for git/dev installs. It checks
// origin/main and fast-forwards only — it never discards local changes.

function shortTime(ts?: number): string {
  if (!ts) return 'not checked'
  return new Date(ts).toLocaleString()
}

export default function UpdatePanel(): JSX.Element {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [busy, setBusy] = useState<'check' | 'run' | null>(null)
  const [runInstall, setRunInstall] = useState(true)
  const [runBuild, setRunBuild] = useState(false)
  const [logs, setLogs] = useState<UpdateLogEntry[]>([])
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      setStatus(await window.api.update.status())
    } catch {
      setStatus(null)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const check = async (): Promise<void> => {
    setBusy('check')
    setNotice(null)
    try {
      const next = await window.api.update.check()
      setStatus(next)
      setNotice(
        next.mode !== 'git'
          ? { kind: 'info', text: 'This is not a source/git install.' }
          : next.hasUpdate
            ? { kind: 'info', text: `Update available — ${next.behindBy} commit(s) behind origin/main.` }
            : { kind: 'ok', text: 'Up to date with origin/main.' }
      )
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(null)
    }
  }

  const run = async (): Promise<void> => {
    setBusy('run')
    setNotice(null)
    setLogs([])
    try {
      const res: UpdateRunResult = await window.api.update.run({ runInstall, runBuild })
      setStatus(res.status)
      setLogs(res.logs)
      if (res.ok) {
        setNotice({
          kind: 'ok',
          text: res.restartRecommended ? 'Updated to latest main. Restart Akorith to load the new build.' : 'Already up to date.'
        })
      } else {
        setNotice({ kind: 'error', text: res.error ?? 'Update failed.' })
      }
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <div>
          <h2>Update</h2>
          <p>Keep this source/git checkout current with GitHub <code>main</code>. Fast-forward only — it never discards your local changes.</p>
        </div>
        <button type="button" disabled={busy !== null} onClick={() => void check()}>
          {busy === 'check' ? 'Checking…' : 'Check for updates'}
        </button>
      </div>

      {!status ? (
        <div className="settings-hint">Loading update status…</div>
      ) : status.mode === 'packaged' ? (
        <div className="update-packaged">
          <div className="ollama-status is-info">This Akorith is not running from a git checkout.</div>
          <p className="settings-hint">
            The source updater applies to dev/source installs (run via <code>npm run dev</code> or built locally).
            Packaged release auto-updates are planned for a later phase. App version: <code>{status.appVersion}</code>.
          </p>
        </div>
      ) : (
        <>
          <div className="ctrl-grid">
            <div className="ctrl-field">
              <span>Branch</span>
              <code>{status.currentBranch}</code>
            </div>
            <div className="ctrl-field">
              <span>Current commit</span>
              <code>{status.currentCommit ?? '—'}</code>
            </div>
            <div className="ctrl-field">
              <span>origin/main</span>
              <code>{status.remoteMainCommit ?? '—'}</code>
            </div>
            <div className="ctrl-field">
              <span>Status</span>
              <code>
                {status.hasUpdate ? `${status.behindBy} behind` : 'up to date'}
                {status.aheadBy > 0 ? ` · ${status.aheadBy} ahead` : ''}
                {status.isDirty ? ' · local changes' : ''}
              </code>
            </div>
          </div>

          <div className="settings-hint">Last checked {shortTime(status.lastCheckedAt)} · remote {status.remoteUrl ?? '—'}</div>

          {status.warnings.length > 0 && (
            <div className="update-warnings">
              {status.warnings.map((w, i) => (
                <div key={i} className="ollama-status is-info">{w}</div>
              ))}
            </div>
          )}

          <div className="settings-checks">
            <label>
              <input type="checkbox" checked={runInstall} onChange={(e) => setRunInstall(e.target.checked)} />
              <span>Run npm install after update (if dependencies changed)</span>
            </label>
            <label>
              <input type="checkbox" checked={runBuild} onChange={(e) => setRunBuild(e.target.checked)} />
              <span>Run npm run build after update (verify the new build)</span>
            </label>
          </div>

          <div className="settings-action-row">
            <button
              type="button"
              className="is-primary"
              disabled={busy !== null || !status.safeToUpdate}
              title={status.safeToUpdate ? 'Fast-forward to origin/main' : 'No safe update available (up to date, dirty tree, or origin/main missing)'}
              onClick={() => void run()}
            >
              {busy === 'run' ? 'Updating…' : 'Update to latest main'}
            </button>
          </div>

          {notice && <div className={`ollama-status is-${notice.kind}`}>{notice.text}</div>}

          {logs.length > 0 && (
            <div className="update-logs">
              {logs.map((entry, i) => (
                <div key={i} className={`update-log ${entry.ok ? 'is-ok' : 'is-err'}`}>
                  <div className="update-log-cmd">
                    <span>{entry.ok ? '✓' : '✕'}</span>
                    <code>{entry.command}</code>
                  </div>
                  {entry.output && <pre className="update-log-out">{entry.output}</pre>}
                </div>
              ))}
            </div>
          )}

          <div className="settings-note">
            The updater only ever runs <code>git fetch</code>, <code>git switch main</code>, and
            <code> git merge --ff-only</code> (plus the optional npm steps you choose). It never resets, discards
            changes, or force-pushes. Restart Akorith after updating to load the new build.
          </div>
        </>
      )}
    </section>
  )
}

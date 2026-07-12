# Production troubleshooting

Start with the smallest read-only check. Preserve `loopex.db`, `loopex.config.json`, remote-node state, and repository worktrees before changing or reinstalling anything.

## App does not launch or closes immediately

From the repository:

```powershell
node --version
npm ci
npm run typecheck
npm run test:native
npm run build
```

Node 22 is recommended. `test:native` launches Electron with temporary user data and proves the Electron ABI can load both `better-sqlite3` and `node-pty`. If SQLite fails after an Electron version change, run only:

```powershell
npm run rebuild
```

This rebuilds `better-sqlite3` for Electron. Do not rebuild node-pty from its npm tarball.

On macOS, if PTYs fail with `posix_spawnp failed`, repair the packaged node-pty helper mode:

```bash
node scripts/fix-spawn-helper.js
```

After any `src/main` or `src/preload` edit in development, fully restart `npm run dev`; electron-vite HMR updates renderer code but does not reliably rebuild those processes in place.

## Empty projects/chats after upgrade

Quit every Akorith instance and reopen the packaged app once. Akorith waits for SQLite readiness and copies only missing legacy `loopex.db`/`loopex.config.json` into the current Akorith userData; it does not overwrite an existing current database.

Do not delete `loopex.db`. Find platform data locations first:

- Windows: `%APPDATA%\Akorith`;
- macOS: `~/Library/Application Support/Akorith`.

Copy the whole userData directory to a safe backup before investigating duplicates or legacy locations. SQLite uses WAL, so include `loopex.db-wal` and `loopex.db-shm` if Akorith was not cleanly shut down.

## Provider is unavailable

Run the provider directly in a normal terminal:

```powershell
claude --version
codex --version
opencode --version
ollama list
git --version
```

Authenticate with the provider's own CLI. Akorith does not store those CLI credentials. For Ollama, confirm `http://127.0.0.1:11434/api/tags` responds. Refresh provider discovery after the runtime is ready.

Finder-launched macOS apps receive a small PATH. Packaged Akorith prepends common Homebrew/user-bin paths, but a CLI installed elsewhere still will not resolve. Put the executable on a standard PATH or launch it with a standard package install; do not paste a secret into Akorith config.

## Model appears in chat but not Loop

This is expected until a capability probe succeeds. Open Loop, refresh the catalog, run the code-execution probe for the exact model/source/node, and inspect the reason badge.

Common blockers are missing/stale/failed probe, model unavailable, probe identity mismatch after a model/runtime change, or one of the 12 mandatory capabilities not confirmed. Restarting a remote runtime, changing quantization/model key, or moving between local/remote sources requires a new probe. A reasoning-only probe qualifies a planner, not an executor.

## Loop cannot create or clone a project

Check:

```powershell
git --version
git ls-remote https://github.com/OWNER/REPOSITORY.git
git config --global user.name
git config --global user.email
```

Use a canonical GitHub HTTPS/SSH URL supported by Akorith. Existing repositories must be reachable and accept a non-interactive dry-run push through the current Git credential manager/SSH configuration. Akorith sets `GIT_TERMINAL_PROMPT=0`, so it will not hang on an invisible credential prompt.

New-project automatic remote creation requires a live authenticated GitHub marketplace adapter. If the plugin only reports its bundled manifest/lifecycle, paste an already-created GitHub URL instead.

Directory conflict means the selected parent already has the project slug. Choose a different name/parent; do not delete that folder through Loop.

## Loop is paused, stuck, or in error

- `paused`: Resume is safe; no cycle will schedule while paused.
- `pausing`/`stopping` after a crash: restart recovery converts it to the stable paused/stopped state.
- `pushing`: inspect the cycle. A committed-but-unpushed cycle retries push before new work.
- repeated task reverts: inspect validation output and detected commands; the repository toolchain may be missing or the executor may not satisfy the fixture.
- token/cost limit: raise the advanced limit deliberately or create a new Loop; the hard stop is intentional.
- authentication/permission/repository-corrupt/remote-mismatch: repair Git access or repository state before resuming.
- `Repository recovery failed`: do not run a second executor. Inspect Git status and operation state manually.

Read-only Git diagnostics:

```powershell
git status --porcelain=v1
git branch --show-current
git remote -v
git rev-parse HEAD
git diff --stat
```

Resolve or explicitly abort a merge/rebase/cherry-pick/revert/bisect using normal Git procedures. Akorith never uses broad hard reset/clean recovery. Preserve unrelated user changes.

## Benchmark produces no rank

A formal rank requires every fixture in all eight categories to complete with valid independent evidence in a compatible workload cohort. Partial, cancelled, timed-out, invalid-evidence, simulated, mismatched-seed, or incompatible-setting runs are excluded.

Open evidence drill-down and look for:

- no runnable declared package test;
- nonzero/timed-out test command;
- no changed artifact;
- out-of-workspace or more than 64 reported changed paths;
- missing original fixture file;
- unknown token/cost fields (quality can still rank, but efficiency remains unavailable);
- a repetition recorded on different hardware/model/configuration and therefore excluded from its environment cohort.

The current production validator does not infer behavior from executor text. A low or missing score can be honest evidence rather than a harness crash.

If Akorith closed during a run, persisted `running` records become failed with an interruption message on next list/get; start a new run rather than editing the stored JSON.

## Plugin never becomes connected

Installed and enabled are lifecycle states, not connection proof. A credential-backed plugin also needs an OS-encrypted credential and a live adapter probe that returns fresh, verified, authenticated health. The bundled marketplace service correctly returns disconnected when no runtime adapter is wired.

If configuration reports OS encryption unavailable, do not work around it with plaintext config. Fix the OS keychain/credential service and retry. A stale health report requires a new adapter check. Disable/uninstall is local and does not revoke a credential at the upstream service; revoke upstream access separately when necessary.

## Remote node cannot pair

On the Windows node:

```powershell
Get-NetTCPConnection -LocalPort 47841 -State Listen
Get-NetFirewallRule -DisplayName "Akorith Node 47841 (Private)"
```

On the client:

```bash
curl http://HOST:47841/v1/info
```

Use the actual PC/Tailscale address, not `0.0.0.0` or `127.0.0.1` from another machine. Pair within two minutes using both the current pairing ID and six-digit code. Restart the daemon to issue a new challenge after expiration, replay, or five failed attempts. Enable private-LAN HTTP acknowledgement only for a trusted private/Tailscale address.

Public/unknown hostnames need HTTPS and explicit public opt-in; public HTTP is rejected. Do not add credentials to the URL. See [Remote nodes](production-remote-node.md).

## Remote node pairs but has no models

On the host, check the runtime loopback endpoint:

```powershell
Invoke-RestMethod http://127.0.0.1:11434/api/tags
Invoke-RestMethod http://127.0.0.1:1234/v1/models
Invoke-RestMethod http://127.0.0.1:8000/v1/models
```

Only the runtime(s) you actually enabled need to answer. Pull/load a model, then refresh the node catalog. OpenAI-compatible runtimes report coding capabilities as unknown until client probes establish evidence.

## GPU card is unavailable

Run:

```powershell
nvidia-smi --query-gpu=index,uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits
```

Local NVIDIA sampling is supported on Windows/Linux. macOS correctly reports `nvidia-smi` unsupported; an M1 client can display the paired Windows node's reported NVIDIA device instead. Missing driver, malformed/unsupported fields, timeout, or disconnected remote node yields an honest reason and no synthetic values.

The monitor backs off after failures, so recovery may not appear immediately; use the Remote node Test action and wait for the next poll. Detailed GPU history is retained 48 hours before 15-minute rollup.

## Dashboard appears empty

Dashboard intentionally has empty states when no persisted events exist. Send a real chat request or complete a Loop/Benchmark/plugin action, then revisit. Legacy `usage_events` backfill runs at database initialization and is idempotent.

If chat history exists but telemetry does not, review main-process logs for `[telemetry] event persistence failed`. Telemetry failures do not block chat, so disk-full/database errors can create a genuine gap. Do not seed or edit counters manually.

## Packaged update is unsupported or fails

- Development run: unsupported by design; install a packaged Windows/macOS release.
- No update: verify a newer semantic version and the correct stable/beta channel exist in GitHub Releases.
- Download failure: verify the release has matching `latest.yml`/`latest-mac.yml`, installer/ZIP, and blockmaps.
- Stable rejects release: a prerelease tag belongs on beta.
- Install unauthorized: click the explicit install action again; its one-use authorization expires after about two minutes.
- Signature/checksum/notarization error: do not retry around verification. Remove/fix the bad release and publish a higher correctly signed version.

See [Updates and releases](production-updates-releases.md) for artifact and signature checks.

## Windows icon or identity is stale

Confirm you launched the NSIS-installed `Akorith.exe`, not Electron development mode or an old unpacked folder. Uninstall only entries clearly belonging to Akorith, remove stale Akorith shortcuts/taskbar pins, reinstall the current NSIS artifact, and restart Explorer if its icon cache remains stale. Do not remove userData during this process.

## Restore the pre-rebuild state

Do not overwrite the current repository. Clone the verified Desktop backup bundle into a new destination and apply its captured patch; follow [Backup restoration](production-backup-restore.md).

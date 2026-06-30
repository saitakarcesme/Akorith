# Phase 42 (Remote Ollama) — Mac App Currency + Remote Ollama Auto-Sync

Branched from `main` (`633d37b`). Makes the Mac automatically use the PC's Ollama models
both on the same Wi-Fi and away from home (Tailscale/VPN/Controller), and lets the Mac
check whether the installed app is current with `main`.

## Naming note (read the history first)

`main` already contains **two** other "Phase 42" tracks done from the PC — `Phase 42.1–42.6`
**Windows icon identity** and `Phase 42.1–42.6` **startup hydration** (both merged). To avoid
colliding with those numbers, this track's commits are tagged **`Phase 42 (Remote Ollama) N:`**.

## Audit — what already exists (build on it)

- `src/main/providers/local.ts`: localhost + loopback fallback, bounded **LAN subnet discovery**,
  Ollama auto-start, private-IP-aware "LAN only / use Tailscale" error.
- `src/main/ollama-connection.ts`: **`autoConnectOllama()`** resolver — tries configured →
  last-successful → enabled remote profiles (by priority), picks the first healthy `/api/tags`,
  caches `lastSuccessfulBaseUrl`, records per-profile health. IPC: `ollama:getSettings/setSettings/
  testEndpoint/autoConnect/getShareInfo`. Address classifier (loopback/LAN/VPN-Tailscale).
- `config.ts`: `OllamaRemoteProfile` + `LocalProviderSettings.remoteProfiles[]` + `lastSuccessfulBaseUrl`.
- `remote-telemetry.ts` (Phase 36): remote **Controller** profiles (PC), `/health` + `/v1/gpu`.
- `ChatPanel.tsx`: auto-calls `ollama.autoConnect()` on launch and shows the active endpoint
  label in the model picker (`modelSource`).
- `SettingsCenter.tsx`: Ollama settings + remote-profile UI + an Auto-connect button.

## Gaps this track fills

1. **Tailscale auto-discovery** — none today. Add `tailscale status --json` peer detection so the
   Mac finds the PC's Ollama (`100.x:11434`) automatically when away, without manual config.
2. **Controller-derived endpoint** — let an enabled Controller profile contribute an Ollama
   candidate to the resolver.
3. **Build metadata + currency** — embed `version/commit/branch/buildDate/packaged` at build time;
   `app.getBuildInfo()`; compare to `origin/main`; surface in Settings/Dashboard.
4. **Dashboard runtime-source card + presentation readiness** — active source (Local / LAN / Tailscale
   / Controller), model count, last checked, readiness (Ready / Needs attention / Offline / Setup), refresh.
5. **Settings: Tailscale status + "scan for PC Ollama" + setup guidance.**
6. **Docs** for same-network and away (Tailscale/Controller) setup.

## Commit plan (`Phase 42 (Remote Ollama) N`)

1 audit (this) · 2 build-info gen + API · 3 currency check + UI · 4 tailscale detection ·
5 controller+tailscale candidates in resolver · 6 Dashboard runtime card + readiness ·
7 Settings Tailscale/scan/guidance · 8 docs · 9 rebuild+refresh Mac app · 10 final validation.

## Security (hard rules)

No public exposure of Ollama, no auto-binding to `0.0.0.0`, no silent firewall changes, no
hardcoded private IPs, no Tailscale auto-install, controller tokens masked & header-only (never
logged), bounded short-timeout read-only probes, **no aggressive subnet scanning** (existing LAN
discovery stays opt-in/bounded). No GPU/model data faked.

## Preserved

Claude/Codex/OpenCode runtime, token accounting, Controller security, PTY/bridge,
Olympus/Gaia/Atlantis, local Ollama behavior, `loopex.db`/config.

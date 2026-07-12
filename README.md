# Akorith

Akorith is a local-first Electron workspace for chat, terminal-backed coding agents, autonomous repository development, reproducible model evaluation, audited integrations, and authenticated remote model compute. It uses the user's installed Claude, Codex, and OpenCode CLIs, local Ollama, or a paired Akorith Node; Akorith does not require AI-provider API keys.

The current product has six primary surfaces:

- **New chat** and **Workspace** for persistent conversations and project-scoped Claude, Codex, and OpenCode terminals.
- **Dashboard** for persisted token, task, model, plugin, streak, and measured GPU activity.
- **Loop** for continuous observe-plan-edit-validate-review-commit-push cycles with no approval between successful cycles.
- **Benchmark** for versioned, isolated, evidence-based comparisons of local, remote, and cloud models.
- **Plugins** for 30 bundled, permission-declared integration manifests with honest lifecycle and connection state.
- **Settings** for providers, remote nodes, packaged updates, and product preferences.

## Install and run

Node.js 22 is recommended. Node.js 20 is the minimum target used by the standalone node bundle. Windows 10 1809+ and macOS Apple Silicon are supported; Linux packaging exists but is not a validated primary target.

```powershell
npm install
npm run dev
```

Optional providers are detected independently:

- `claude`, logged in with the Claude CLI;
- `codex`, logged in with the Codex CLI;
- `opencode`, authenticated with `opencode auth login`;
- Ollama at `http://127.0.0.1:11434` or a configured endpoint;
- models exposed by a paired Akorith Node.

A missing provider is shown as unavailable and does not prevent the rest of the app from starting.

## Verify and package

```powershell
npm run typecheck
npm test
npm run test:native
npm run verify:existing
npm run build
```

Package on the target operating system:

```powershell
npm run dist:win
```

```bash
npm run dist:mac
```

Windows produces an NSIS installer and portable executable. macOS produces DMG and ZIP artifacts; the ZIP is also required by the packaged updater. Release builds publish through GitHub Releases and generate stable/beta update metadata. Signing and notarization require repository secrets and must be verified on the produced artifacts; see [Updates and releases](docs/production-updates-releases.md).

## Remote RTX compute

Build or run the inference-only node on the model host:

```powershell
npm run node:build
node .\dist-node\akorith-node.cjs --host 0.0.0.0 --port 47841 --allow-lan --name "RTX 3090 PC"
```

The node discovers Ollama (`11434`), LM Studio (`1234`), and vLLM/OpenAI-compatible (`8000`) on loopback. It does not receive repository filesystem, command, or Git access; code tools remain on the Akorith client. For the exact RTX 3090 Windows PC to M1 MacBook Air setup, including Windows Firewall and Tailscale guidance, see [Remote nodes](docs/production-remote-node.md).

## Data and security

- Electron runs with context isolation and sandboxing enabled and Node integration disabled.
- The renderer receives a frozen, narrowly typed preload API; external payloads are validated in the main process.
- Git uses shell-free `execFile`, explicit pathspecs, repository leases, non-force pushes, and bounded output.
- The one programmatic terminal injection path remains `bridgeSend()` to `PtyManager.write()`.
- Chat history, configuration, telemetry, Loop state, model probes, and Benchmark runs are local application data.
- Remote-node bearer tokens use Electron `safeStorage`. The plugin credential-vault contract also requires OS encryption and fails closed; the current bundled integrations do not accept or persist credentials until a live adapter/configuration flow exists.
- Unified telemetry excludes prompts, responses, terminal output, file contents, credentials, and raw command output.

See [Telemetry and privacy](docs/production-telemetry-privacy.md) for storage, backfill, and GPU-retention details.

## Production documentation

- [Architecture and testing](docs/production-architecture.md)
- [Autonomous Loop](docs/production-autonomous-loop.md)
- [Benchmark methodology and metric definitions](docs/production-benchmark.md)
- [Plugin development and permissions](docs/production-plugins.md)
- [Remote nodes, RTX 3090 host, M1 client, and Tailscale](docs/production-remote-node.md)
- [Packaged updates, releases, signing, and notarization](docs/production-updates-releases.md)
- [Telemetry, privacy, retention, and backfill](docs/production-telemetry-privacy.md)
- [Troubleshooting](docs/production-troubleshooting.md)
- [Backup restoration](docs/production-backup-restore.md)

## Important operational limits

- Loop only offers an executor after a fresh successful code-execution probe confirms every mandatory capability. Endpoint reachability alone is insufficient.
- The bundled GitHub marketplace manifest and repository adapter contract exist, but automatic repository creation remains unavailable until the GitHub plugin has a live authenticated runtime adapter. Pasting an existing GitHub URL remains supported.
- Benchmark records only independently observed evidence. Metrics that a provider or host cannot report remain unavailable; Akorith does not substitute synthetic values.
- The standalone node currently serves HTTP. Plaintext HTTP is accepted by the client only for a private address after explicit acknowledgement. Use Tailscale or a trusted LAN, do not port-forward it to the public internet, and use HTTPS for any address that is not provably private.
- Code signing, notarization, live RTX hardware validation, and physical macOS validation require the corresponding credentials and machines. The repository contains the release workflow and validation seams, not fabricated external evidence.

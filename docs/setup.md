# Akorith — Setup & One-Command Bootstrap

Goal: hand an agent (Claude/Codex) the repo URL and have it stand Akorith up on a
fresh Mac or PC with minimal manual steps. Akorith is **local-first** — it never
collects or stores your provider secrets; it only checks tooling and prints the
exact sign-in commands for you to run.

## TL;DR

```bash
git clone https://github.com/saitakarcesme/Akorith.git
cd Akorith
npm run setup        # check toolchain + install deps + print auth steps
npm run dev          # start the desktop app
```

Windows (PowerShell):

```powershell
git clone https://github.com/saitakarcesme/Akorith.git
cd Akorith
pwsh scripts/setup-akorith.ps1
npm run dev
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run setup` / `setup:mac` | Check toolchain, install deps, print auth steps |
| `npm run doctor` | Check-only (no changes) — `setup-akorith.sh --check` |
| `bash scripts/setup-akorith.sh --install-deps` | Force a dependency reinstall |
| `bash scripts/setup-akorith.sh --with-global-tools` | Offer to install missing CLIs (asks first) |
| `bash scripts/setup-akorith.sh --start` | Set up, then launch the dev app |
| `pwsh scripts/setup-akorith.ps1 [-Check] [-InstallDeps] [-Start]` | Windows equivalent |

## What setup checks

- **Required:** Node 20+, npm, git.
- **Agents/tools (optional):** Claude CLI, Codex CLI, OpenCode (`opencode`), Ollama, GitHub CLI (`gh`).
- **Plugin foundations (optional):** Chrome/Chromium, Python + `chromadb`, `nvidia-smi`.

For anything missing it prints an install hint; it never installs global software
without `--with-global-tools` and an explicit `y` confirmation.

## Signing in (you run these — Akorith never stores secrets)

| Tool | Command |
| --- | --- |
| Claude | follow Anthropic's CLI login (`claude`) |
| Codex | follow OpenAI's Codex CLI login |
| OpenCode (Gaia) | `opencode auth login` (also works inside Akorith's Gaia pane) |
| GitHub | `gh auth login` |
| Ollama | `ollama serve`, then `ollama pull <model>` |

For a remote GPU/Ollama box: enable the Controller API + Allow-LAN on the PC
(Settings → API), then add a remote telemetry profile on the Mac (Settings → API).
See `docs/controller-api.md`.

## iCloud / synced-folder trap (macOS)

If the repo lives under `~/Desktop` or `~/Documents`, iCloud Drive evicts
`node_modules` files into "dataless" placeholders, which **hangs** `tsc`, `vite`,
and `npm`. The setup script detects this and prints the fix — relocate
`node_modules` outside the synced tree and symlink it back:

```bash
EXT="$HOME/Library/Application Support/akorith-dev/node_modules"
mkdir -p "$EXT" && rm -rf node_modules && ln -s "$EXT" node_modules && npm install
```

…or move the whole repo to a non-synced directory (e.g. `~/dev/Akorith`).

## Keeping machines current

Use **Settings → Update** in the app to fast-forward this checkout to GitHub
`main` (see `docs/update-system.md`). To refresh the packaged macOS app, run
`npm run macos:refresh` after `npm run pack:mac`.

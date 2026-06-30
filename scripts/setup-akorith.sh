#!/usr/bin/env bash
#
# Akorith one-command setup / doctor (macOS + Linux).
#
# Goal: "Here is the Akorith GitHub URL — put this on my machine and connect
# everything." This checks the toolchain, installs dependencies, and prints the
# exact (never-automated) auth steps for Claude / Codex / OpenCode / Ollama / gh.
# It NEVER collects secrets, prints tokens, or hardcodes personal paths.
#
# Usage:
#   bash scripts/setup-akorith.sh                # check + install deps
#   bash scripts/setup-akorith.sh --check        # check only (doctor), no changes
#   bash scripts/setup-akorith.sh --install-deps # force dependency install
#   bash scripts/setup-akorith.sh --start        # after setup, start the dev app
#   bash scripts/setup-akorith.sh --with-global-tools   # offer to install missing CLIs (asks first)
#
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

CHECK_ONLY=0; FORCE_INSTALL=0; START=0; WITH_GLOBAL=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    --install-deps) FORCE_INSTALL=1 ;;
    --start) START=1 ;;
    --with-global-tools) WITH_GLOBAL=1 ;;
    *) echo "unknown flag: $arg" ;;
  esac
done

ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
warn() { printf "  \033[33m!\033[0m %s\n" "$1"; }
miss() { printf "  \033[31m✗\033[0m %s\n" "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

echo "== Akorith setup =="
echo "repo: $REPO_ROOT"

# ---- 1. Required toolchain ----
echo "-- required --"
if have node; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${NODE_MAJOR:-0}" -ge 20 ]; then ok "node $(node -v)"; else warn "node $(node -v) — Akorith expects Node 20+"; fi
else miss "node not found — install Node 20+ (https://nodejs.org or nvm)"; fi
have npm && ok "npm $(npm -v)" || miss "npm not found"
have git && ok "git $(git --version | awk '{print $3}')" || miss "git not found"

# ---- 2. iCloud / synced-folder guard (the recurring node_modules killer) ----
case "$REPO_ROOT" in
  *"/Desktop/"*|*"/Documents/"*)
    if command -v brctl >/dev/null 2>&1 && brctl status >/dev/null 2>&1; then
      warn "This repo is under an iCloud-synced folder (Desktop/Documents)."
      warn "iCloud evicts node_modules files and hangs tsc/vite/npm."
      if [ -L node_modules ]; then
        ok "node_modules is already a symlink outside iCloud — good."
      else
        echo "    Fix (move node_modules out of iCloud, keep the repo in place):"
        echo "      EXT=\"\$HOME/Library/Application Support/akorith-dev/node_modules\""
        echo "      mkdir -p \"\$EXT\" && rm -rf node_modules && ln -s \"\$EXT\" node_modules && npm install"
        echo "    …or move the whole repo to a non-synced dir (e.g. ~/dev/Akorith)."
      fi
    fi
    ;;
esac

# ---- 3. Dependencies ----
if [ "$CHECK_ONLY" -eq 0 ]; then
  if [ "$FORCE_INSTALL" -eq 1 ] || [ ! -d node_modules ] || [ -L node_modules ]; then
    echo "-- installing dependencies --"
    npm install --no-audit --no-fund && ok "dependencies installed" || miss "npm install failed"
  else
    ok "node_modules present (use --install-deps to reinstall)"
  fi
fi

# ---- 4. Agent / tool CLIs (auth is the user's to complete) ----
echo "-- agents & tools (optional) --"
have claude   && ok "Claude CLI $(claude --version 2>/dev/null | head -1)"    || warn "Claude CLI not found  → install per Anthropic docs"
have codex    && ok "Codex CLI present"                                       || warn "Codex CLI not found   → install per OpenAI docs"
have opencode && ok "OpenCode (Gaia) $(opencode --version 2>/dev/null | head -1)" || warn "OpenCode not found    → npm i -g opencode-ai"
have ollama   && ok "Ollama $(ollama --version 2>/dev/null | head -1)"        || warn "Ollama not found      → https://ollama.com"
have gh       && ok "GitHub CLI $(gh --version 2>/dev/null | head -1)"        || warn "GitHub CLI not found  → https://cli.github.com"

# ---- 5. Optional plugin foundations ----
echo "-- plugin foundations (optional) --"
if [ -d "/Applications/Google Chrome.app" ] || have google-chrome || have chromium; then ok "Chrome/Chromium detected (Browser plugin)"; else warn "Chrome/Chromium not detected"; fi
if have python3 && python3 -c "import chromadb" >/dev/null 2>&1; then ok "Python + chromadb detected (Chroma memory)"; else warn "Python+chromadb not detected (Chroma memory is optional)"; fi
if have nvidia-smi; then ok "nvidia-smi detected (GPU telemetry)"; else warn "nvidia-smi not present (expected on macOS; remote GPU profiles cover the PC)"; fi

# ---- 6. Optional global tool install (asks first) ----
if [ "$WITH_GLOBAL" -eq 1 ] && [ "$CHECK_ONLY" -eq 0 ]; then
  if ! have opencode; then
    read -r -p "Install OpenCode globally with 'npm i -g opencode-ai'? [y/N] " yn
    case "$yn" in [Yy]*) npm i -g opencode-ai && ok "opencode installed" ;; *) warn "skipped opencode install" ;; esac
  fi
fi

# ---- 7. Auth next steps (never automated, never collected) ----
cat <<'EOF'

-- next: sign in to the tools you use (Akorith never stores these) --
  Claude    : follow Anthropic's CLI login (claude)        — terminal / browser
  Codex     : follow OpenAI's Codex CLI login              — terminal / browser
  OpenCode  : opencode auth login                           — interactive (Gaia pane works too)
  GitHub    : gh auth login                                 — interactive
  Ollama    : ollama serve   then   ollama pull <model>     — local models
  Remote GPU: enable the Controller API + Allow-LAN on the PC (Settings → API),
              then add a remote telemetry profile on the Mac (Settings → API).

EOF

echo "== setup complete =="
echo "Start Akorith with:  npm run dev"

if [ "$START" -eq 1 ] && [ "$CHECK_ONLY" -eq 0 ]; then
  echo "Starting dev app…"
  npm run dev
fi

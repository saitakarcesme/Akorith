<#
  Akorith one-command setup / doctor (Windows PowerShell).

  Goal: "Here is the Akorith GitHub URL — put this on my PC and connect
  everything." Checks the toolchain, installs dependencies, and prints the exact
  (never-automated) auth steps for Claude / Codex / OpenCode / Ollama / gh.
  It NEVER collects secrets, prints tokens, or hardcodes personal paths.

  Usage:
    pwsh scripts/setup-akorith.ps1                 # check + install deps
    pwsh scripts/setup-akorith.ps1 -Check          # check only (doctor)
    pwsh scripts/setup-akorith.ps1 -InstallDeps    # force dependency install
    pwsh scripts/setup-akorith.ps1 -Start          # start the dev app after setup
    pwsh scripts/setup-akorith.ps1 -WithGlobalTools  # offer to install missing CLIs (asks first)
#>
param(
  [switch]$Check,
  [switch]$InstallDeps,
  [switch]$Start,
  [switch]$WithGlobalTools
)
$ErrorActionPreference = 'Continue'

$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

function Ok($m)   { Write-Host "  [ok]  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [! ]  $m" -ForegroundColor Yellow }
function Miss($m) { Write-Host "  [x ]  $m" -ForegroundColor Red }
function Have($c) { return [bool](Get-Command $c -ErrorAction SilentlyContinue) }

Write-Host "== Akorith setup =="
Write-Host "repo: $RepoRoot"

# ---- 1. Required toolchain ----
Write-Host "-- required --"
if (Have node) {
  $nodeMajor = [int](node -p "process.versions.node.split('.')[0]" 2>$null)
  if ($nodeMajor -ge 20) { Ok "node $(node -v)" } else { Warn "node $(node -v) - Akorith expects Node 20+" }
} else { Miss "node not found - install Node 20+ (https://nodejs.org)" }
if (Have npm) { Ok "npm $(npm -v)" } else { Miss "npm not found" }
if (Have git) { Ok "git $((git --version) -replace 'git version ','')" } else { Miss "git not found" }

# ---- 2. Dependencies ----
if (-not $Check) {
  if ($InstallDeps -or -not (Test-Path node_modules)) {
    Write-Host "-- installing dependencies --"
    npm install --no-audit --no-fund
    if ($LASTEXITCODE -eq 0) { Ok "dependencies installed" } else { Miss "npm install failed" }
  } else {
    Ok "node_modules present (use -InstallDeps to reinstall)"
  }
}

# ---- 3. Agent / tool CLIs (auth is the user's to complete) ----
Write-Host "-- agents & tools (optional) --"
if (Have claude)   { Ok "Claude CLI present" }   else { Warn "Claude CLI not found  -> install per Anthropic docs" }
if (Have codex)    { Ok "Codex CLI present" }    else { Warn "Codex CLI not found   -> install per OpenAI docs" }
if (Have opencode) { Ok "OpenCode present" }     else { Warn "OpenCode not found    -> npm i -g opencode-ai" }
if (Have ollama)   { Ok "Ollama present" }       else { Warn "Ollama not found      -> https://ollama.com" }
if (Have gh)       { Ok "GitHub CLI present" }   else { Warn "GitHub CLI not found  -> https://cli.github.com" }

# ---- 4. Optional plugin foundations ----
Write-Host "-- plugin foundations (optional) --"
$chrome = (Test-Path "$Env:ProgramFiles\Google\Chrome\Application\chrome.exe") -or (Have chrome)
if ($chrome) { Ok "Chrome detected (Browser plugin)" } else { Warn "Chrome not detected" }
if ((Have python) -and (python -c "import chromadb" 2>$null; $LASTEXITCODE -eq 0)) { Ok "Python + chromadb detected (Chroma memory)" } else { Warn "Python+chromadb not detected (optional)" }
if (Have nvidia-smi) { Ok "nvidia-smi detected (GPU telemetry)" } else { Warn "nvidia-smi not present (install NVIDIA driver for GPU telemetry)" }

# ---- 5. Optional global tool install (asks first) ----
if ($WithGlobalTools -and -not $Check) {
  if (-not (Have opencode)) {
    $yn = Read-Host "Install OpenCode globally with 'npm i -g opencode-ai'? [y/N]"
    if ($yn -match '^[Yy]') { npm i -g opencode-ai; Ok "opencode installed" } else { Warn "skipped opencode install" }
  }
}

# ---- 6. Auth next steps (never automated, never collected) ----
@"

-- next: sign in to the tools you use (Akorith never stores these) --
  Claude    : follow Anthropic's CLI login (claude)        - terminal / browser
  Codex     : follow OpenAI's Codex CLI login              - terminal / browser
  OpenCode  : opencode auth login                           - interactive (Gaia pane works too)
  GitHub    : gh auth login                                 - interactive
  Ollama    : ollama serve   then   ollama pull <model>     - local models
  Remote GPU: enable the Controller API + Allow-LAN on the PC (Settings -> API),
              then add a remote telemetry profile on the Mac (Settings -> API).
"@ | Write-Host

Write-Host "== setup complete =="
Write-Host "Start Akorith with:  npm run dev"

if ($Start -and -not $Check) {
  Write-Host "Starting dev app..."
  npm run dev
}

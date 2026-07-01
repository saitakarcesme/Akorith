param(
  [switch]$NoBuild,
  [switch]$NoInstall,
  [switch]$NoLaunch,
  [switch]$SkipUninstall,
  [switch]$KeepShortcuts
)

$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
  throw 'refresh-windows-app.ps1 must be run on Windows.'
}

$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$AppId = 'com.akorith.app'
$AppName = 'Akorith'
$ExpectedInstallRoots = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\Akorith'),
  (Join-Path $env:ProgramFiles 'Akorith')
)
if (${env:ProgramFiles(x86)}) {
  $ExpectedInstallRoots += (Join-Path ${env:ProgramFiles(x86)} 'Akorith')
}
$ExpectedInstallRoots = $ExpectedInstallRoots | ForEach-Object { [System.IO.Path]::GetFullPath($_) }

function Write-Step($Message) {
  Write-Host ''
  Write-Host "== $Message =="
}

function Test-AkorithOwnedPath($Path) {
  if (-not $Path) { return $false }
  try {
    $full = [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($Path))
  } catch {
    return $false
  }
  foreach ($root in $ExpectedInstallRoots) {
    if ($full.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }
  }
  return $full -match '(?i)(\\|/)akorith(\\|/|\.exe|$)'
}

function Get-ShortcutInfo($Path) {
  try {
    $wsh = New-Object -ComObject WScript.Shell
    $shortcut = $wsh.CreateShortcut($Path)
    return [PSCustomObject]@{
      Path = $Path
      TargetPath = $shortcut.TargetPath
      Arguments = $shortcut.Arguments
      WorkingDirectory = $shortcut.WorkingDirectory
      IconLocation = $shortcut.IconLocation
    }
  } catch {
    return $null
  }
}

function Backup-Shortcut($Path, $BackupDir) {
  $info = Get-ShortcutInfo $Path
  if (-not $info) { return }

  $name = [System.IO.Path]::GetFileNameWithoutExtension($Path)
  $identity = @($info.TargetPath, $info.Arguments, $info.WorkingDirectory, $info.IconLocation) -join ' '
  $isAkorithShortcut = $name -eq 'Akorith' -and ($identity -match '(?i)akorith|com\.akorith\.app|electron')
  $isOldElectronShortcut = $name -eq 'Electron' -and ($identity -match '(?i)akorith|com\.akorith\.app')

  if (-not ($isAkorithShortcut -or $isOldElectronShortcut)) { return }
  if ($isOldElectronShortcut -and -not (Test-AkorithOwnedPath $identity)) { return }

  New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
  $dest = Join-Path $BackupDir ([System.IO.Path]::GetFileName($Path))
  $suffix = 1
  while (Test-Path -LiteralPath $dest) {
    $dest = Join-Path $BackupDir ("{0}-{1}.lnk" -f $name, $suffix)
    $suffix++
  }
  Move-Item -LiteralPath $Path -Destination $dest
  Write-Host "Moved stale shortcut to backup: $dest"
}

function Get-AkorithUninstallEntries {
  $roots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )

  foreach ($root in $roots) {
    Get-ItemProperty -Path $root -ErrorAction SilentlyContinue | ForEach-Object {
      $displayName = [string]$_.DisplayName
      $identity = @($_.DisplayName, $_.InstallLocation, $_.DisplayIcon, $_.UninstallString) -join ' '
      $isAkorith = $displayName -match '^Akorith(\s|$)'
      $isOldElectronForAkorith = $displayName -eq 'Electron' -and $identity -match '(?i)akorith|com\.akorith\.app'
      if ($isAkorith -or $isOldElectronForAkorith) {
        [PSCustomObject]@{
          DisplayName = $displayName
          InstallLocation = $_.InstallLocation
          DisplayIcon = $_.DisplayIcon
          UninstallString = $_.UninstallString
        }
      }
    }
  }
}

function Split-UninstallCommand($CommandLine) {
  if (-not $CommandLine) { return $null }
  $trimmed = [Environment]::ExpandEnvironmentVariables($CommandLine.Trim())
  if ($trimmed -match '^\s*"([^"]+)"\s*(.*)$') {
    return [PSCustomObject]@{ Exe = $matches[1]; Args = $matches[2] }
  }
  if ($trimmed -match '^\s*(.+?\.exe)\s*(.*)$') {
    return [PSCustomObject]@{ Exe = $matches[1]; Args = $matches[2] }
  }
  return $null
}

function Invoke-AkorithUninstaller($Entry) {
  $cmd = Split-UninstallCommand $Entry.UninstallString
  if (-not $cmd) {
    Write-Warning "Cannot parse uninstaller for $($Entry.DisplayName). Use Apps & Features manually."
    return
  }
  if (-not (Test-Path -LiteralPath $cmd.Exe)) {
    Write-Warning "Uninstaller is missing: $($cmd.Exe)"
    return
  }
  if (-not (Test-AkorithOwnedPath $cmd.Exe) -and -not (Test-AkorithOwnedPath $Entry.InstallLocation)) {
    Write-Warning "Refusing uninstaller outside Akorith paths: $($cmd.Exe)"
    return
  }

  $args = $cmd.Args
  if ($args -notmatch '(^|\s)/S(\s|$)') {
    $args = ($args + ' /S').Trim()
  }
  Write-Host "Running Akorith uninstaller: $($cmd.Exe) $args"
  Start-Process -FilePath $cmd.Exe -ArgumentList $args -Wait
}

function Stop-InstalledAkorith {
  Get-CimInstance Win32_Process -Filter "Name = 'Akorith.exe'" -ErrorAction SilentlyContinue |
    Where-Object { Test-AkorithOwnedPath $_.ExecutablePath } |
    ForEach-Object {
      Write-Host "Stopping running Akorith process $($_.ProcessId)"
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-NpmScript($ScriptName) {
  $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
  if (-not $npm) { $npm = (Get-Command npm -ErrorAction Stop).Source }
  Push-Location $RepoRoot
  try {
    & $npm run $ScriptName
    if ($LASTEXITCODE -ne 0) {
      throw "npm run $ScriptName failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
}

function Invoke-UnsignedWindowsInstallerBuild {
  $npx = (Get-Command npx.cmd -ErrorAction SilentlyContinue).Source
  if (-not $npx) { $npx = (Get-Command npx -ErrorAction Stop).Source }
  Push-Location $RepoRoot
  try {
    Write-Warning 'Retrying local installer build with Windows executable resource editing disabled.'
    & $npx electron-builder --win --config.win.signAndEditExecutable=false
    if ($LASTEXITCODE -ne 0) {
      throw "unsigned Windows installer build failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
}

function Get-LatestInstaller {
  $dist = Join-Path $RepoRoot 'dist'
  if (-not (Test-Path -LiteralPath $dist)) { return $null }
  return Get-ChildItem -LiteralPath $dist -Filter 'Akorith-Setup-*-x64.exe' -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
}

function Get-InstalledAkorithExe {
  foreach ($root in $ExpectedInstallRoots) {
    $exe = Join-Path $root 'Akorith.exe'
    if (Test-Path -LiteralPath $exe) { return $exe }
  }
  return $null
}

Write-Step 'Akorith Windows refresh'
Write-Host "Repo: $RepoRoot"
Write-Host "AppUserModelID: $AppId"
Write-Host 'This script never removes Akorith user data/config/db.'

Stop-InstalledAkorith

if (-not $KeepShortcuts) {
  Write-Step 'Backing up stale Akorith shortcuts'
  $backupDir = Join-Path ([Environment]::GetFolderPath('Desktop')) ("Akorith-windows-shortcuts-{0:yyyyMMdd-HHmmss}" -f (Get-Date))
  $shortcutDirs = @(
    [Environment]::GetFolderPath('Desktop'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
    (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar')
  )
  foreach ($dir in $shortcutDirs) {
    foreach ($name in @('Akorith.lnk', 'Electron.lnk')) {
      $shortcut = Join-Path $dir $name
      if (Test-Path -LiteralPath $shortcut) {
        Backup-Shortcut $shortcut $backupDir
      }
    }
  }
  if (-not (Test-Path -LiteralPath $backupDir)) {
    Write-Host 'No stale Akorith/Electron-for-Akorith shortcuts found.'
  }
}

if (-not $SkipUninstall) {
  Write-Step 'Checking old Akorith installs'
  $entries = @(Get-AkorithUninstallEntries)
  if ($entries.Count -eq 0) {
    Write-Host 'No Akorith uninstall entries found.'
  } else {
    foreach ($entry in $entries) {
      Write-Host "Found: $($entry.DisplayName) at $($entry.InstallLocation)"
      if (-not $NoInstall) {
        Invoke-AkorithUninstaller $entry
      }
    }
  }
}

if (-not $NoBuild) {
  Write-Step 'Building Windows installer'
  $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  try {
    Invoke-NpmScript 'dist:win'
  } catch {
    Write-Warning $_.Exception.Message
    Write-Warning 'If the failure mentions winCodeSign symbolic links, enable Windows Developer Mode or run the shell as Administrator, then retry.'
    Write-Warning 'Do not install by copying dist\win-unpacked; that folder can contain Electron default resources if packaging stopped early.'
    Invoke-UnsignedWindowsInstallerBuild
  }
}

if (-not $NoInstall) {
  Write-Step 'Installing latest Akorith installer'
  $installer = Get-LatestInstaller
  if (-not $installer) {
    Write-Warning 'No Akorith NSIS installer found under dist/. Run npm run dist:win on Windows or use the GitHub Actions Windows artifact.'
  } else {
    Write-Host "Running installer: $($installer.FullName)"
    Start-Process -FilePath $installer.FullName -ArgumentList '/S' -Wait
  }
}

if (-not $NoLaunch) {
  Write-Step 'Launching installed Akorith'
  $exe = Get-InstalledAkorithExe
  if ($exe) {
    Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe)
    Write-Host "Launched: $exe"
  } else {
    Write-Warning 'Installed Akorith.exe was not found. Complete the installer manually, then launch Akorith from Start Menu.'
  }
}

Write-Step 'If Windows still shows the old Electron icon'
Write-Host '1. Uninstall old Akorith/Electron entries from Settings > Apps.'
Write-Host '2. Delete stale Desktop/Start Menu shortcuts and unpin old taskbar icons.'
Write-Host '3. Install the latest Akorith-Setup-<version>-x64.exe.'
Write-Host '4. Restart Explorer, or clear the Windows icon cache if the old icon persists.'
Write-Host '5. Launch packaged Akorith, not npm run dev.'

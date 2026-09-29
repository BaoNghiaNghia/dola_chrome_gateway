param(
  [switch]$SkipChecks,
  [switch]$PortableOnly
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Root = Split-Path -Parent $PSScriptRoot
$BuildTargetRoot = Join-Path $Root "src-tauri\target-build"
$TauriTarget = Join-Path $BuildTargetRoot "release"
$ReleaseDir = Join-Path $Root "release\windows"
$PortableDir = Join-Path $ReleaseDir "portable"

function Assert-Command {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,
    [Parameter(Mandatory = $true)]
    [string]$InstallHint
  )

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing required command '$Name'. $InstallHint"
  }
}

function Invoke-Step {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Title,
    [Parameter(Mandatory = $true)]
    [scriptblock]$Command
  )

  Write-Host ""
  Write-Host "==> $Title" -ForegroundColor Cyan
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Title failed with exit code $LASTEXITCODE."
  }
}

Set-Location $Root

# Tauri CLI expects CI to be an explicit boolean when the environment variable
# is present. Some runners expose CI=1, which Tauri rejects as an invalid value.
$env:CI = "false"
# Keep release builds isolated from the target directory used by tauri dev.
# This avoids Cargo build-directory locks while the development app is open.
$env:CARGO_TARGET_DIR = $BuildTargetRoot

Write-Host "Dola Chrome Gateway - Windows Build" -ForegroundColor Magenta
Write-Host "Project: $Root"

Assert-Command -Name "node" -InstallHint "Install Node.js 20+ and reopen the terminal."
Assert-Command -Name "npm" -InstallHint "Install Node.js/npm and reopen the terminal."
Assert-Command -Name "cargo" -InstallHint "Install Rust from https://rustup.rs and reopen the terminal."

if (-not $SkipChecks) {
  Invoke-Step -Title "Running project checks" -Command {
    & npm.cmd run check
  }
}

if ($PortableOnly) {
  Invoke-Step -Title "Building portable Windows executable" -Command {
    & npm.cmd run tauri -- build --no-bundle
  }
} else {
  Invoke-Step -Title "Building Windows app and NSIS installer" -Command {
    & npm.cmd run tauri -- build --bundles nsis
  }
}

if (-not (Test-Path $TauriTarget)) {
  throw "Tauri release output was not found at '$TauriTarget'."
}

if (Test-Path $ReleaseDir) {
  Remove-Item $ReleaseDir -Recurse -Force
}
New-Item -ItemType Directory -Path $PortableDir -Force | Out-Null

$PortableSource = Join-Path $TauriTarget "dola-chrome-gateway.exe"
if (-not (Test-Path $PortableSource)) {
  throw "Portable executable was not found at '$PortableSource'."
}

Copy-Item $PortableSource (Join-Path $PortableDir "Dola-Chrome-Gateway.exe") -Force
Copy-Item (Join-Path $Root "adapter") (Join-Path $PortableDir "adapter") -Recurse -Force

$RequiredAdapterFiles = @(
  "seedance-adapter.mjs",
  "profile-download-watcher.mjs",
  "seedance-driver.mjs",
  "video-result.mjs",
  "cdp.mjs"
)
foreach ($AdapterFile in $RequiredAdapterFiles) {
  $AdapterPath = Join-Path (Join-Path $PortableDir "adapter") $AdapterFile
  if (-not (Test-Path $AdapterPath)) {
    throw "Portable build is missing required adapter resource '$AdapterFile' at '$AdapterPath'."
  }
}

if (-not $PortableOnly) {
  $NsisDir = Join-Path $TauriTarget "bundle\nsis"
  if (-not (Test-Path $NsisDir)) {
    throw "NSIS installer output was not found at '$NsisDir'."
  }

  Get-ChildItem $NsisDir -Filter "*.exe" -File -Recurse |
    ForEach-Object {
      Copy-Item $_.FullName (Join-Path $ReleaseDir $_.Name) -Force
    }
}

$Package = Get-Content (Join-Path $Root "package.json") -Raw | ConvertFrom-Json
$BuildInfo = @(
  "Dola Chrome Gateway"
  "Version: $($Package.version)"
  "Built: $([DateTimeOffset]::Now.ToString('o'))"
  "Portable: portable\Dola-Chrome-Gateway.exe"
  $(if ($PortableOnly) { "Installer: not built" } else { "Installer: NSIS .exe" })
  "Profile storage: E:\Dola Chrome"
  "Default page: https://www.dola.com/chat"
  "Default zoom: 85%"
  "Runtime requirement: Node.js 20+ is required for Seedance Automation"
)
Set-Content -Path (Join-Path $ReleaseDir "build-info.txt") -Value $BuildInfo -Encoding UTF8

$Artifacts = Get-ChildItem $ReleaseDir -File -Recurse
if (-not $Artifacts) {
  throw "Build completed, but no Windows artifacts were collected."
}

Write-Host ""
Write-Host "Build complete." -ForegroundColor Green
Write-Host "Artifacts: $ReleaseDir" -ForegroundColor Green
$Artifacts |
  ForEach-Object {
    Write-Host ("  - " + $_.FullName.Substring($ReleaseDir.Length + 1))
  }

param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("check", "write", "print")]
  [string]$Action,
  [ValidateSet("portable", "windows")]
  [string]$Kind = "portable"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Get-SourceFingerprint {
  $paths = @()
  $paths += (& git ls-files)
  $paths += (& git ls-files --others --exclude-standard)
  $paths = $paths |
    Where-Object {
      $_ -and
      -not $_.StartsWith("release/") -and
      -not $_.StartsWith("src-tauri/target") -and
      -not $_.StartsWith(".build-cache/")
    } |
    Sort-Object -Unique

  $lines = New-Object System.Collections.Generic.List[string]
  foreach ($relative in $paths) {
    $full = Join-Path $Root $relative
    if (-not (Test-Path $full -PathType Leaf)) {
      continue
    }
    $hash = (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLowerInvariant()
    $lines.Add($relative + [char]9 + $hash)
  }

  $payload = [string]::Join([Environment]::NewLine, $lines)
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

$cacheDir = Join-Path $Root ".build-cache"
$stampPath = Join-Path $cacheDir "$Kind.sha256"
$fingerprint = Get-SourceFingerprint

switch ($Action) {
  "print" {
    Write-Output $fingerprint
    exit 0
  }
  "write" {
    New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
    Set-Content -Path $stampPath -Value $fingerprint -Encoding ASCII
    Write-Host "[Dola] Saved $Kind build stamp: $fingerprint"
    exit 0
  }
  "check" {
    if (-not (Test-Path $stampPath -PathType Leaf)) {
      Write-Host "[Dola] No $Kind build stamp found."
      exit 1
    }
    $saved = (Get-Content $stampPath -Raw).Trim().ToLowerInvariant()
    if ($saved -eq $fingerprint) {
      Write-Host "[Dola] $Kind build stamp matches current source."
      exit 0
    }
    Write-Host "[Dola] $Kind build stamp is stale."
    exit 1
  }
}

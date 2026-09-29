import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_MTIME_TOLERANCE_MS = 2_500;

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedWinPath(value) {
  const raw = String(value || "").trim();
  if (!raw || !path.win32.isAbsolute(raw)) return null;
  return path.win32.normalize(raw);
}

export function createSessionDestinationRouter(fallbackDir) {
  let locked = false;
  let primarySourcePath = null;
  let outputDir = String(fallbackDir || "");

  return {
    get locked() {
      return locked;
    },
    get primarySourcePath() {
      return primarySourcePath;
    },
    get outputDir() {
      return outputDir;
    },
    lock(sourcePath) {
      if (locked) return false;
      locked = true;

      const normalized = normalizedWinPath(sourcePath);
      if (!normalized) return false;

      primarySourcePath = normalized;
      outputDir = path.win32.dirname(normalized);
      return true;
    },
  };
}

export function chooseUniqueSourcePath(
  file,
  candidates,
  { mtimeToleranceMs = DEFAULT_MTIME_TOLERANCE_MS } = {},
) {
  const name = String(file?.name || "").trim();
  const size = finiteNumber(file?.size);
  const lastModified = finiteNumber(file?.lastModified);
  if (!name || size === null || lastModified === null || lastModified <= 0) {
    return null;
  }

  const matches = [];
  const seen = new Set();
  for (const candidate of candidates || []) {
    const candidatePath = normalizedWinPath(candidate?.path);
    if (!candidatePath) continue;

    const key = candidatePath.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    if (path.win32.basename(candidatePath).toLowerCase() !== name.toLowerCase()) {
      continue;
    }

    const candidateSize = finiteNumber(candidate?.size);
    const candidateModified = finiteNumber(candidate?.lastModified);
    if (candidateSize !== size || candidateModified === null) continue;
    if (Math.abs(candidateModified - lastModified) > mtimeToleranceMs) continue;

    matches.push(candidatePath);
  }

  return matches.length === 1 ? matches[0] : null;
}

const POWERSHELL_COMMON = String.raw`
$ErrorActionPreference = "Stop"
$name = $env:DOLA_SOURCE_NAME
if ([string]::IsNullOrWhiteSpace($name)) {
  Write-Output "[]"
  exit 0
}

$paths = New-Object System.Collections.Generic.List[string]
`;

const POWERSHELL_SERIALIZE = String.raw`
$items = New-Object System.Collections.Generic.List[object]
$seen = @{}
foreach ($candidate in $paths) {
  try {
    $item = Get-Item -LiteralPath $candidate -Force -ErrorAction Stop
    $key = $item.FullName.ToLowerInvariant()
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true
    $modified = [DateTimeOffset]::new($item.LastWriteTimeUtc).ToUnixTimeMilliseconds()
    $items.Add([PSCustomObject]@{
      path = $item.FullName
      size = [Int64]$item.Length
      lastModified = [Int64]$modified
    })
  } catch {}
}
Write-Output (ConvertTo-Json -InputObject @($items) -Compress)
`;

const EXPLORER_SOURCE_QUERY =
  POWERSHELL_COMMON +
  String.raw`
try {
  $shell = New-Object -ComObject Shell.Application
  foreach ($window in @($shell.Windows())) {
    try {
      $folder = [string]$window.Document.Folder.Self.Path
      if ([string]::IsNullOrWhiteSpace($folder)) { continue }
      $candidate = Join-Path $folder $name
      if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        $paths.Add($candidate)
      }
    } catch {}
  }
} catch {}
` +
  POWERSHELL_SERIALIZE;

const WINDOWS_SEARCH_QUERY =
  POWERSHELL_COMMON +
  String.raw`
$connection = $null
$recordset = $null
try {
  $connection = New-Object -ComObject ADODB.Connection
  $connection.Open("Provider=Search.CollatorDSO;Extended Properties='Application=Windows';")
  $escaped = $name.Replace("'", "''")
  $query = "SELECT TOP 100 System.ItemPathDisplay FROM SYSTEMINDEX WHERE System.FileName = '$escaped'"
  $recordset = $connection.Execute($query)
  while (-not $recordset.EOF) {
    try {
      $candidate = [string]$recordset.Fields.Item("System.ItemPathDisplay").Value
      if (-not [string]::IsNullOrWhiteSpace($candidate) -and
          (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        $paths.Add($candidate)
      }
    } catch {}
    $recordset.MoveNext()
  }
} catch {
  # Windows Search is optional.
} finally {
  try { if ($recordset) { $recordset.Close() } } catch {}
  try { if ($connection) { $connection.Close() } } catch {}
}
` +
  POWERSHELL_SERIALIZE;

function parseCandidateOutput(stdout) {
  const raw = String(stdout || "").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  } catch {
    return [];
  }
}

async function queryWindowsCandidates(script, file, timeoutMs) {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 512 * 1024,
        env: {
          ...process.env,
          DOLA_SOURCE_NAME: String(file?.name || ""),
        },
      },
    );
    return parseCandidateOutput(stdout);
  } catch {
    return [];
  }
}

export async function resolveDroppedFilePath(file, options = {}) {
  if (process.platform !== "win32") {
    return { path: null, reason: "unsupported_platform", candidates: 0 };
  }

  // Stage 1: the source Explorer folder is normally already open because the
  // user is dragging from it. Resolve there first and avoid Windows Search.
  const explorerCandidates = await queryWindowsCandidates(
    EXPLORER_SOURCE_QUERY,
    file,
    Number(options.explorerTimeoutMs || 1_500),
  );
  const explorerPath = chooseUniqueSourcePath(file, explorerCandidates, options);
  if (explorerPath) {
    return {
      path: explorerPath,
      reason: "explorer_unique_metadata_match",
      candidates: explorerCandidates.length,
    };
  }

  // Stage 2: only fall back to the indexed Windows Search catalog when the
  // open Explorer folders did not produce a unique high-confidence match.
  const searchCandidates = await queryWindowsCandidates(
    WINDOWS_SEARCH_QUERY,
    file,
    Number(options.searchTimeoutMs || 3_000),
  );
  const combined = [...explorerCandidates, ...searchCandidates];
  const sourcePath = chooseUniqueSourcePath(file, combined, options);
  return {
    path: sourcePath,
    reason: sourcePath ? "search_unique_metadata_match" : "no_unique_match",
    candidates: combined.length,
  };
}

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ArchivePath,

  [string]$ImageRef = "",
  [string]$ContainerName = "playwright-player",
  [int]$HostPort = 3000,
  [string]$RuntimeRoot = (Join-Path (Get-Location) "offline-runtime"),
  [switch]$DisableIpcHost
)

$ErrorActionPreference = "Stop"

function Require-Command {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command not found: $Name"
  }
}

function Expand-GzipArchive {
  param(
    [Parameter(Mandatory = $true)]
    [string]$SourcePath,

    [Parameter(Mandatory = $true)]
    [string]$TargetPath
  )

  $inputStream = [System.IO.File]::OpenRead($SourcePath)
  try {
    $outputStream = [System.IO.File]::Create($TargetPath)
    try {
      $gzipStream = New-Object System.IO.Compression.GzipStream(
        $inputStream,
        [System.IO.Compression.CompressionMode]::Decompress
      )
      try {
        $gzipStream.CopyTo($outputStream)
      } finally {
        $gzipStream.Dispose()
      }
    } finally {
      $outputStream.Dispose()
    }
  } finally {
    $inputStream.Dispose()
  }
}

Require-Command "docker"

$archive = Resolve-Path $ArchivePath
$runtimeRoot = [System.IO.Path]::GetFullPath($RuntimeRoot)
$scriptsDir = Join-Path $runtimeRoot "scripts"
$storageStatesDir = Join-Path $runtimeRoot "storage-states"
$dataDir = Join-Path $runtimeRoot "data"

New-Item -ItemType Directory -Force -Path $scriptsDir, $storageStatesDir, $dataDir | Out-Null

$loadTarget = $archive.Path
$tempTarPath = $null
if ($loadTarget.EndsWith(".tar.gz", [System.StringComparison]::OrdinalIgnoreCase)) {
  $tempTarPath = Join-Path ([System.IO.Path]::GetTempPath()) ("playwright-player-" + [System.Guid]::NewGuid().ToString("N") + ".tar")
  Write-Host "Decompressing archive to temporary tar file..."
  Expand-GzipArchive -SourcePath $loadTarget -TargetPath $tempTarPath
  $loadTarget = $tempTarPath
}

try {
  Write-Host "Loading Docker image from $archive"
  $loadOutput = & docker load -i $loadTarget 2>&1
  $loadOutput | ForEach-Object { Write-Host $_ }

  if (-not $ImageRef) {
    $loadedLine = $loadOutput | Where-Object { $_ -match "^Loaded image: " } | Select-Object -Last 1
    if ($loadedLine) {
      $ImageRef = ($loadedLine -replace "^Loaded image:\s*", "").Trim()
    }
  }

  if (-not $ImageRef) {
    throw "Unable to determine image reference automatically. Please pass -ImageRef explicitly."
  }

  $existingContainer = & docker ps -a --format "{{.Names}}" | Where-Object { $_ -eq $ContainerName }
  if ($existingContainer) {
    Write-Host "Removing existing container $ContainerName"
    & docker rm -f $ContainerName | Out-Null
  }

  $runArgs = @(
    "run",
    "-d",
    "--name", $ContainerName,
    "--init"
  )

  if (-not $DisableIpcHost) {
    $runArgs += "--ipc=host"
  }

  $runArgs += @(
    "-p", "${HostPort}:3000",
    "-e", "PORT=3000",
    "-e", "DEFAULT_HEADLESS=true",
    "-e", "ENABLE_EVALUATE=true",
    "-v", "${scriptsDir}:/app/scripts",
    "-v", "${storageStatesDir}:/app/storage-states",
    "-v", "${dataDir}:/app/data",
    $ImageRef
  )

  Write-Host "Starting container $ContainerName from image $ImageRef"
  $containerId = (& docker @runArgs).Trim()

  Write-Host ""
  Write-Host "Container started."
  Write-Host "  Container : $ContainerName"
  Write-Host "  Image     : $ImageRef"
  Write-Host "  Id        : $containerId"
  Write-Host "  Runtime   : $runtimeRoot"
  Write-Host "  Health    : http://127.0.0.1:$HostPort/health"
  Write-Host "  Docs      : http://127.0.0.1:$HostPort/docs"
  Write-Host "  Playground: http://127.0.0.1:$HostPort/playground"
  Write-Host ""
  Write-Host "Mounted directories:"
  Write-Host "  Scripts        : $scriptsDir"
  Write-Host "  Storage states : $storageStatesDir"
  Write-Host "  Data           : $dataDir"
  Write-Host ""
  Write-Host "Stop commands:"
  Write-Host "  docker stop $ContainerName"
  Write-Host "  docker rm $ContainerName"
} finally {
  if ($tempTarPath -and (Test-Path $tempTarPath)) {
    Remove-Item -Force $tempTarPath
  }
}

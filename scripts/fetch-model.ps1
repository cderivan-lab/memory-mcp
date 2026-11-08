# Fetch the embedding model files into the directory the server looks in first.
#
# The directory name and file names come from src/model-manifest.json — the same
# manifest the Rust loader embeds and the VS Code installer reads — so a rename
# cannot leave this script downloading files nobody looks for.
#
# Usage: scripts/fetch-model.ps1
#
# Writes to $env:PALI_MODEL_DIR when set, otherwise ./models/<dir> relative to
# the current directory, so running it from the workspace root populates the
# path the loader resolves (ADR-0049). Pali never downloads the model itself;
# this is a developer/CI convenience and needs only curl.exe (shipped with
# Windows 10 1803+).
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$manifest = Join-Path $root "src/model-manifest.json"
$baseUrl = "https://huggingface.co"

if (-not (Test-Path -LiteralPath $manifest)) {
    Write-Error "fetch-model: missing $manifest"
    exit 1
}

$manifestJson = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json

$modelId = $manifestJson.id
$dirName = $manifestJson.dir
$files = @($manifestJson.files.PSObject.Properties | ForEach-Object { $_.Value })

if ([string]::IsNullOrWhiteSpace($modelId) -or [string]::IsNullOrWhiteSpace($dirName) -or $files.Count -eq 0) {
    Write-Error 'fetch-model: the manifest must define "id", "dir", and a "files" object'
    exit 1
}

$target = if ($env:PALI_MODEL_DIR) { $env:PALI_MODEL_DIR } else { Join-Path "models" $dirName }
New-Item -ItemType Directory -Path $target -Force | Out-Null

foreach ($file in $files) {
    $dest = Join-Path $target $file
    if (Test-Path -LiteralPath $dest) {
        $length = (Get-Item -LiteralPath $dest).Length
        if ($length -gt 0) {
            Write-Host "fetch-model: $file already present"
            continue
        }
    }
    Write-Host "fetch-model: fetching $modelId/$file"
    $part = "$dest.part"
    & curl.exe -fsSL --retry 3 --retry-delay 1 -o $part "$baseUrl/$modelId/resolve/main/$file"
    if ($LASTEXITCODE -ne 0) {
        Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue
        Write-Error "fetch-model: download of $file failed (curl exit $LASTEXITCODE)"
        exit 1
    }
    Move-Item -LiteralPath $part -Destination $dest -Force
}

Write-Host "fetch-model: $modelId is provisioned in $target"

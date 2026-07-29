# Builds the production bundle and zips dist/'s *contents* (not the folder
# itself) at the repo root level, since the Chrome Web Store expects
# manifest.json at the zip root.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$distPath = Join-Path $root "dist"
$manifestPath = Join-Path $distPath "manifest.json"

Push-Location $root
try {
    npm run build:prod
    if ($LASTEXITCODE -ne 0) { throw "build:prod failed" }

    $version = (Get-Content $manifestPath -Raw | ConvertFrom-Json).version
    $zipPath = Join-Path $root "qalens-v$version.zip"
    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

    Compress-Archive -Path "$distPath\*" -DestinationPath $zipPath
    Write-Host "Packaged: $zipPath"
} finally {
    Pop-Location
}

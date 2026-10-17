param(
  [string]$Python = "python"
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$tauriRoot = Join-Path $repoRoot "apps\desktop\src-tauri"
$outputDirectory = Join-Path $tauriRoot "binaries"
$workDirectory = Join-Path $repoRoot ".build\pyinstaller"
$targetTriple = (& rustc --print host-tuple).Trim()
if ($LASTEXITCODE -ne 0 -or -not $targetTriple) { throw "Could not determine the Rust target triple." }

New-Item -ItemType Directory -Force -Path $outputDirectory, $workDirectory | Out-Null
$binaryName = "lke-api-$targetTriple"
Push-Location $repoRoot
try {
  & $Python -m PyInstaller --noconfirm --clean --onefile --name $binaryName `
    --paths backend --distpath $outputDirectory --workpath $workDirectory `
    --specpath $workDirectory --collect-all fastapi --collect-all starlette `
    --collect-all pydantic --collect-all uvicorn --collect-all anyio `
    backend\sidecar_entry.py
  if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed with exit code $LASTEXITCODE." }
} finally {
  Pop-Location
}

Write-Host "Built $binaryName for $targetTriple in $outputDirectory"

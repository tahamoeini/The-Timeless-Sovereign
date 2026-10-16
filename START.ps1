$ErrorActionPreference = 'Stop'

$workspaceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $workspaceRoot

if (-not $env:STORY_STUDIO_PORT) {
    $env:STORY_STUDIO_PORT = '4317'
}

npm start

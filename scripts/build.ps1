# Build the GD helper for Windows into bin\gd-helper.exe.
# Needs Go (see helper-src\go.mod) and, at runtime, Chrome or Edge.
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..\helper-src")
go build -trimpath -ldflags "-s -w" -o "..\bin\gd-helper.exe" .
Write-Host "built bin\gd-helper.exe"
# Install Microsoft.Trusted.Signing.Client (the signtool dlib).
# One-time setup; re-run to upgrade.
#
# Caches Azure.CodeSigning.Dlib.dll into .signing/ at the repo root.
# scripts/sign-windows.cjs looks for it there.
#
# No dotnet/NuGet CLI required - we hit the NuGet REST API directly.

param(
  [string]$Version = "1.0.86"
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$cacheDir = Join-Path $repoRoot ".signing"
$nupkgPath = Join-Path $cacheDir "Microsoft.Trusted.Signing.Client.$Version.nupkg"
$extractDir = Join-Path $cacheDir "extracted"
$targetDll = Join-Path $cacheDir "Azure.CodeSigning.Dlib.dll"

New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null

Write-Host "Downloading Microsoft.Trusted.Signing.Client v$Version from nuget.org..."
$nupkgUrl = "https://www.nuget.org/api/v2/package/Microsoft.Trusted.Signing.Client/$Version"
Invoke-WebRequest -Uri $nupkgUrl -OutFile $nupkgPath -UseBasicParsing

Write-Host "Extracting .nupkg (it is just a .zip)..."
if (Test-Path $extractDir) { Remove-Item -Recurse -Force $extractDir }
# PowerShell 5.1's Expand-Archive only accepts .zip extension, so rename
# the .nupkg copy to .zip first.
$zipPath = [System.IO.Path]::ChangeExtension($nupkgPath, '.zip')
Copy-Item -Path $nupkgPath -Destination $zipPath -Force
Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force
Remove-Item -Path $zipPath -Force

# The dlib lives under bin/ in the package. Path layout has been stable
# but we search recursively to survive minor reorganizations.
$found = Get-ChildItem -Path $extractDir -Filter "Azure.CodeSigning.Dlib.dll" -Recurse | Select-Object -First 1
if (-not $found) {
  throw "Azure.CodeSigning.Dlib.dll not found in extracted package - layout changed?"
}

Copy-Item -Path $found.FullName -Destination $targetDll -Force

# Also copy any peer DLLs the dlib depends on into the same folder so
# signtool can resolve them at load time. The dlib has Azure.* peers.
$peerDir = $found.DirectoryName
Get-ChildItem -Path $peerDir -Filter "*.dll" | ForEach-Object {
  $dest = Join-Path $cacheDir $_.Name
  Copy-Item -Path $_.FullName -Destination $dest -Force
}

Write-Host "OK: dlib installed at $targetDll" -ForegroundColor Green
Write-Host ""
Write-Host "Next: set these three env vars before running 'npm run electron:build':"
Write-Host "  AZURE_TENANT_ID"
Write-Host "  AZURE_CLIENT_ID"
Write-Host "  AZURE_CLIENT_SECRET"

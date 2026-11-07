# Verifies an editor's extension dev host actually loads this extension and can
# run the analyzer. Antigravity hides --extensionDevelopmentPath from --help, so
# "does my dev loop work here" can only be answered empirically.
#
#   npm run smoke:host                 # Antigravity IDE (default)
#   ... -Editor cursor | code | antigravity
param(
  [ValidateSet('antigravity', 'cursor', 'code')]
  [string]$Editor = 'antigravity',
  [string]$Workspace = "$PSScriptRoot\..\targets\dub\apps\web"
)

$ErrorActionPreference = 'Stop'
$proj = (Resolve-Path "$PSScriptRoot\..").Path

$cli = switch ($Editor) {
  'antigravity' { "$env:LOCALAPPDATA\Programs\Antigravity IDE\bin\antigravity-ide.cmd" }
  'cursor'      { "$env:LOCALAPPDATA\Programs\cursor\resources\app\bin\cursor.cmd" }
  'code'        { "$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd" }
}
if (-not (Test-Path $cli)) { Write-Error "CLI not found for '$Editor': $cli"; exit 2 }
if (-not (Test-Path $Workspace)) { Write-Error "Workspace not found: $Workspace"; exit 2 }

# onStartupFinished so activation happens without a human running the command.
$pkgPath = "$proj\package.json"
$pkgBackup = Get-Content $pkgPath -Raw
try {
  $pkg = $pkgBackup | ConvertFrom-Json
  $pkg.activationEvents = @('onStartupFinished')
  $pkg | ConvertTo-Json -Depth 20 | Set-Content $pkgPath -Encoding utf8

  & node "$proj\scripts\build.mjs" | Out-Null

  $marker = Join-Path $env:TEMP 'archlink-activation.log'
  if (Test-Path $marker) { Remove-Item $marker -Force }

  Write-Output "launching $Editor dev host on $Workspace ..."
  Start-Process -FilePath $cli -ArgumentList @(
    "--extensionDevelopmentPath=$proj", '--new-window', $Workspace
  )

  for ($i = 1; $i -le 90; $i++) {
    Start-Sleep -Seconds 1
    if ((Test-Path $marker) -and (((Get-Content $marker) -join '') -match 'ANALYSIS')) {
      Write-Output "PASS after ~$i s:"
      Get-Content $marker | ForEach-Object { Write-Output "  $_" }
      exit 0
    }
  }
  Write-Output "FAIL: no analysis marker after 90s"
  if (Test-Path $marker) { Get-Content $marker | ForEach-Object { Write-Output "  $_" } }
  exit 1
}
finally {
  # Always restore lazy activation, whatever happened above.
  Set-Content $pkgPath -Value $pkgBackup -Encoding utf8 -NoNewline
  & node "$proj\scripts\build.mjs" | Out-Null
}

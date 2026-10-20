# Stops the Starport server, physically purges deleted rows from hub.sqlite
# (WAL checkpoint + VACUUM), then launches a fresh server.
# Run this only AFTER deleting the conversation(s) in the Starport UI.
param([int]$GraceSeconds = 25, [int]$MaxWaitMinutes = 12)
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
$log = Join-Path $root '.data\purge.log'
function Log($m) { Add-Content -Path $log -Value ("{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) -Encoding UTF8 }

Log "purge requested (grace=$GraceSeconds s, max wait=$MaxWaitMinutes min)"
Start-Sleep -Seconds $GraceSeconds

$running = '1'
$started = Get-Date
while ((Get-Date) -lt $started.AddMinutes($MaxWaitMinutes)) {
  $running = (& $node (Join-Path $root 'scripts\hub-running.mjs') (Join-Path $root '.data\hub.sqlite') 2>$null | Select-Object -Last 1)
  $running = "$running".Trim()
  if ($running -eq '0') { break }
  Log "waiting for $running running turn(s) to finish"
  Start-Sleep -Seconds 10
}
if ($running -ne '0') { Log "gave up waiting (still $running running turn(s))"; exit 1 }

$serverJson = Join-Path $root '.data\server.json'
if (Test-Path $serverJson) {
  try {
    $serverPid = (Get-Content $serverJson -Raw | ConvertFrom-Json).pid
    if ($serverPid) {
      $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$serverPid" -ErrorAction SilentlyContinue
      if ($proc -and ($proc.CommandLine -match 'server\.mjs')) {
        Log "stopping server (pid=$serverPid)"
        Stop-Process -Id $serverPid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
      } else {
        Log "pid $serverPid is not a harness-hub server; leaving it alone"
      }
    }
  } catch { Log "could not read server.json: $_" }
}

Log 'running database purge (checkpoint + VACUUM)'
& $node (Join-Path $root 'scripts\purge-db.mjs') (Join-Path $root '.data\hub.sqlite') 2>&1 | ForEach-Object { Log "purge: $_" }

Log 'launching server'
& $node (Join-Path $root 'scripts\launch.mjs') --no-open 2>&1 | ForEach-Object { Log "launch: $_" }
Log 'purge + restart done'

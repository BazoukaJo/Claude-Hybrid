# Stops every process listening on the given TCP port (LISTENING).
# Uses Get-NetTCPConnection when available, otherwise parses netstat -ano.
param(
    [Parameter(Mandatory = $false)]
    [int]$Port = 8082
)

$ErrorActionPreference = 'Continue'
$pids = [System.Collections.Generic.HashSet[int]]::new()

try {
    if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
        $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        foreach ($c in $conns) {
            $op = [int]$c.OwningProcess
            if ($op -gt 0) { [void]$pids.Add($op) }
        }
    }
}
catch { }

if ($pids.Count -eq 0) {
    try {
        $pat = "^\s*TCP\s+\S+:$Port\s+\S+\s+LISTENING\s+(\d+)\s*$"
        netstat -ano | ForEach-Object {
            $line = $_
            if ($line -match $pat) {
                [void]$pids.Add([int]$Matches[1])
            }
        }
    }
    catch { }
}

if ($pids.Count -eq 0) {
    Write-Host "Nothing listening on port $Port."
    exit 0
}

$ok = $true
foreach ($id in $pids) {
    try {
        Stop-Process -Id $id -Force -ErrorAction Stop
        Write-Host "Stopped PID $id."
    }
    catch {
        Write-Host "Could not stop PID ${id}: $($_.Exception.Message)"
        $ok = $false
    }
}

# Let the OS release the listening socket before restart/start checks the port.
Start-Sleep -Milliseconds 500

if ($ok) { exit 0 } else { exit 1 }

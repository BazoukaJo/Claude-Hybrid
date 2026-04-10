# Removes User-level environment variables written by setup.ps1 (hybrid routing / GPU hints).
# Does not remove ANTHROPIC_API_KEY.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$PrevBaseKey = 'CLAUDE_HYBRID_PREV_ANTHROPIC_BASE_URL'
$ManagedBaseKey = 'CLAUDE_HYBRID_MANAGED_ANTHROPIC_BASE_URL'

function Get-KitRouterUrls {
    $p = [System.Environment]::GetEnvironmentVariable('ROUTER_PORT', 'User')
    if ([string]::IsNullOrWhiteSpace($p)) { $p = $env:ROUTER_PORT }
    if ([string]::IsNullOrWhiteSpace($p)) { $p = '8082' }
    $p = "$p".Trim()
    return @(
        'http://localhost:8082',
        'http://127.0.0.1:8082',
        "http://localhost:$p",
        "http://127.0.0.1:$p"
    )
}

function Is-KitRouterUrl([string]$value, [string[]]$kits) {
    if ([string]::IsNullOrWhiteSpace($value)) { return $false }
    $v = $value.Trim()
    foreach ($k in $kits) {
        if ($v -eq $k) { return $true }
    }
    return $false
}

Write-Host 'User environment (hybrid revert)' -ForegroundColor Cyan

$kits = Get-KitRouterUrls
$curBase = [System.Environment]::GetEnvironmentVariable('ANTHROPIC_BASE_URL', 'User')
$prevBase = [System.Environment]::GetEnvironmentVariable($PrevBaseKey, 'User')
$managed = [System.Environment]::GetEnvironmentVariable($ManagedBaseKey, 'User')
$isManaged = ($managed -eq '1')

if ((Is-KitRouterUrl $curBase $kits) -or ($isManaged -and -not [string]::IsNullOrWhiteSpace($curBase))) {
    if (-not [string]::IsNullOrWhiteSpace($prevBase) -and -not (Is-KitRouterUrl $prevBase $kits)) {
        [System.Environment]::SetEnvironmentVariable('ANTHROPIC_BASE_URL', $prevBase, 'User')
        [System.Environment]::SetEnvironmentVariable($PrevBaseKey, $null, 'User')
        [System.Environment]::SetEnvironmentVariable($ManagedBaseKey, $null, 'User')
        Write-Host "  Restored User: ANTHROPIC_BASE_URL (from saved pre-router value: $prevBase)"
    }
    else {
        [System.Environment]::SetEnvironmentVariable('ANTHROPIC_BASE_URL', $null, 'User')
        if (-not [string]::IsNullOrWhiteSpace($prevBase)) {
            [System.Environment]::SetEnvironmentVariable($PrevBaseKey, $null, 'User')
        }
        if (-not [string]::IsNullOrWhiteSpace($managed)) {
            [System.Environment]::SetEnvironmentVariable($ManagedBaseKey, $null, 'User')
        }
        Write-Host '  Removed User: ANTHROPIC_BASE_URL (no saved pre-router value)'
    }
}
elseif (-not [string]::IsNullOrWhiteSpace($curBase)) {
    Write-Host "  Left User: ANTHROPIC_BASE_URL = $curBase (custom value)"
    if (-not [string]::IsNullOrWhiteSpace($prevBase)) {
        [System.Environment]::SetEnvironmentVariable($PrevBaseKey, $null, 'User')
        Write-Host "  Cleared stale backup key: $PrevBaseKey"
    }
    if (-not [string]::IsNullOrWhiteSpace($managed)) {
        [System.Environment]::SetEnvironmentVariable($ManagedBaseKey, $null, 'User')
        Write-Host "  Cleared stale managed key: $ManagedBaseKey"
    }
}
else {
    Write-Host '  (skip) ANTHROPIC_BASE_URL - not set at User level'
    if (-not [string]::IsNullOrWhiteSpace($prevBase)) {
        [System.Environment]::SetEnvironmentVariable($PrevBaseKey, $null, 'User')
        Write-Host "  Cleared stale backup key: $PrevBaseKey"
    }
    if (-not [string]::IsNullOrWhiteSpace($managed)) {
        [System.Environment]::SetEnvironmentVariable($ManagedBaseKey, $null, 'User')
        Write-Host "  Cleared stale managed key: $ManagedBaseKey"
    }
}

$gpuKitDefaults = @{
    'OLLAMA_GPU_OVERHEAD'   = '0'
    'CUDA_VISIBLE_DEVICES'  = '0'
    'OLLAMA_NUM_GPU_LAYERS' = '99'
}
foreach ($kv in $gpuKitDefaults.GetEnumerator()) {
    $cur = [System.Environment]::GetEnvironmentVariable($kv.Key, 'User')
    if ($cur -eq $kv.Value) {
        [System.Environment]::SetEnvironmentVariable($kv.Key, $null, 'User')
        Write-Host "  Removed User: $($kv.Key) (matched kit default $($kv.Value))"
    }
    elseif ($null -ne $cur -and $cur -ne '') {
        Write-Host "  Left User: $($kv.Key) = $cur (not kit default)"
    }
}

Write-Host 'Done. Restart terminals and your IDE.' -ForegroundColor Green

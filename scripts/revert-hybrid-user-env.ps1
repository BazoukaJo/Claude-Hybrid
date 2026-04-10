# Removes User-level environment variables written by setup.ps1 (hybrid routing / GPU hints).
# Does not remove ANTHROPIC_API_KEY.

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Remove-UserEnv([string]$name) {
    $cur = [System.Environment]::GetEnvironmentVariable($name, "User")
    if ($null -eq $cur -or $cur -eq "") {
        Write-Host "  (skip) $name — not set at User level"
        return
    }
    [System.Environment]::SetEnvironmentVariable($name, $null, "User")
    Write-Host "  Removed User: $name (was: $cur)"
}

Write-Host "User environment (hybrid revert)" -ForegroundColor Cyan
Remove-UserEnv "ANTHROPIC_BASE_URL"

$gpuKitDefaults = @{
    "OLLAMA_GPU_OVERHEAD"   = "0"
    "CUDA_VISIBLE_DEVICES"  = "0"
    "OLLAMA_NUM_GPU_LAYERS" = "99"
}
foreach ($kv in $gpuKitDefaults.GetEnumerator()) {
    $cur = [System.Environment]::GetEnvironmentVariable($kv.Key, "User")
    if ($cur -eq $kv.Value) {
        [System.Environment]::SetEnvironmentVariable($kv.Key, $null, "User")
        Write-Host "  Removed User: $($kv.Key) (matched kit default $($kv.Value))"
    } elseif ($null -ne $cur -and $cur -ne "") {
        Write-Host "  Left User: $($kv.Key) = $cur (not kit default)"
    }
}

Write-Host "Done. Restart terminals and your IDE." -ForegroundColor Green

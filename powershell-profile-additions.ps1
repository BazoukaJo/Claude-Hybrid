# Optional PowerShell profile additions for Claude Hybrid
# These are NOT required — hybrid routing works automatically via ANTHROPIC_BASE_URL.
# Add these only if you want convenient manual overrides.
#
# Open profile: notepad $PROFILE
# Paste below, save, then reload: . $PROFILE

# Force cloud for current session (bypass proxy, useful for testing)
function claude-cloud {
    $saved = $env:ANTHROPIC_BASE_URL
    Remove-Item Env:ANTHROPIC_BASE_URL -ErrorAction SilentlyContinue
    Write-Host "  [cloud] Bypassing proxy - direct Anthropic API" -ForegroundColor Cyan
    claude @args
    $env:ANTHROPIC_BASE_URL = $saved
}

# Check routing status
function claude-mode {
    $url = [System.Environment]::GetEnvironmentVariable("ANTHROPIC_BASE_URL", "User")
    $session = $env:ANTHROPIC_BASE_URL
    if ($session -eq "http://localhost:8082" -or $url -eq "http://localhost:8082") {
        Write-Host "Hybrid routing active (local + cloud auto-routing via proxy)" -ForegroundColor Green
    } elseif ($session -eq "http://localhost:11434") {
        Write-Host "Local only (Gemma 4 via Ollama)" -ForegroundColor Yellow
    } else {
        Write-Host "Cloud only (direct Anthropic API)" -ForegroundColor Cyan
    }
}

# Start Ollama server in background if not running
function ollama-start {
    if (-not (Get-Process -Name "ollama" -ErrorAction SilentlyContinue)) {
        Start-Process ollama -ArgumentList "serve" -WindowStyle Hidden
        Write-Host "Ollama started" -ForegroundColor Green
    } else {
        Write-Host "Ollama already running" -ForegroundColor Gray
    }
}

# setup.ps1 - unified first-time + routing + startup setup (idempotent)
#
# Default: run everything; each step skips work that is already done.
#
#   .\setup.ps1                    Full setup (prereqs, models, env, startup)
#   .\setup.ps1 -RoutingOnly       Env + startup VBS/shortcut + start router if needed
#   .\setup.ps1 -ShortcutOnly      Root .lnk only
#   .\setup.ps1 -Autostart         Login/autostart only: Ollama + router (used by Startup VBS)
#   .\setup.ps1 -NonInteractive    Do not prompt for API key (skip if unset)

param(
    [switch] $RoutingOnly,
    [switch] $ShortcutOnly,
    [switch] $Autostart,
    [switch] $NonInteractive
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ProjectDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$SetupPs = Join-Path $ProjectDir 'setup.ps1'
$ShortcutLnk = Join-Path $ProjectDir 'Claude-Hybrid-Router-Startup.lnk'
$PsExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$StartupFolder = [System.Environment]::GetFolderPath('Startup')
$VbsPath = Join-Path $StartupFolder 'ClaudeHybridRouter.vbs'

$ModelsToPull = @(
    'deepseek-coder-v2:16b',
    'qwen2.5-coder:7b'
)

function Write-Step([string]$msg, [string]$color = 'Gray') {
    Write-Host "  $msg" -ForegroundColor $color
}

function Test-OllamaModelPresent([string]$modelName) {
    if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) { return $false }
    try {
        $null = & ollama show $modelName 2>&1
        return ($LASTEXITCODE -eq 0)
    }
    catch {
        return $false
    }
}

function Test-PortListening([int]$port) {
    try {
        if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
            $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
            return [bool]$c
        }
    }
    catch {}
    try {
        $line = netstat -ano | Select-String "^\s*TCP\s+\S+:$port\s+\S+\s+LISTENING\s+\d+\s*$" | Select-Object -First 1
        return [bool]$line
    }
    catch {}
    return $false
}

function Get-ListeningPid8082 {
    try {
        if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
            $conn = Get-NetTCPConnection -LocalPort 8082 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($conn) { return [int]$conn.OwningProcess }
        }
    }
    catch {}

    try {
        $line = netstat -ano | Select-String '^\s*TCP\s+\S+:8082\s+\S+\s+LISTENING\s+(\d+)\s*$' | Select-Object -First 1
        if ($line -and $line.Matches.Count -gt 0) {
            return [int]$line.Matches[0].Groups[1].Value
        }
    }
    catch {}

    return $null
}

function Invoke-HybridEnvMerge {
    $merge = Join-Path $ProjectDir 'scripts\merge-claude-hybrid-env.js'
    if (-not (Test-Path $merge)) { return }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return }
    if (-not $env:ROUTER_PORT -or $env:ROUTER_PORT -eq '') { $env:ROUTER_PORT = '8082' }
    try {
        & node $merge 2>&1 | Out-Null
    }
    catch { }
}

function Invoke-AutostartDaemon {
    Invoke-HybridEnvMerge
    $RouterJs = Join-Path $ProjectDir 'router\server.js'
    $PidFile = Join-Path $ProjectDir '.claude\router.pid'
    $LogFile = Join-Path $ProjectDir '.claude\router.log'
    $LogErr = Join-Path $ProjectDir '.claude\router.err.log'

    $stateDir = Split-Path -Parent $PidFile
    if (-not (Test-Path $stateDir)) {
        New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
    }

    if (-not (Get-Process -Name 'ollama' -ErrorAction SilentlyContinue)) {
        Start-Process ollama -ArgumentList 'serve' -WindowStyle Hidden
        Start-Sleep -Seconds 3
    }

    $routerRunning = $false
    if (Test-Path $PidFile) {
        $savedPid = Get-Content $PidFile -ErrorAction SilentlyContinue
        if ($savedPid -and (Get-Process -Id ([int]$savedPid) -ErrorAction SilentlyContinue)) {
            $routerRunning = $true
        }
    }

    if (-not $routerRunning) {
        $portPid = Get-ListeningPid8082
        if ($portPid) {
            $routerRunning = $true
            $portProc = Get-Process -Id $portPid -ErrorAction SilentlyContinue
            if ($portProc -and $portProc.ProcessName -eq 'node') {
                $portPid | Out-File $PidFile -Force
            }
        }
    }

    if (-not $routerRunning) {
        if (-not (Test-Path $RouterJs)) { return }
        $rProc = Start-Process node `
            -ArgumentList $RouterJs `
            -WindowStyle Hidden `
            -RedirectStandardOutput $LogFile `
            -RedirectStandardError $LogErr `
            -PassThru
        $rProc.Id | Out-File $PidFile -Force
    }
}

function Ensure-Ollama {
    if (Get-Command ollama -ErrorAction SilentlyContinue) {
        Write-Step "`[Prereq] Ollama already installed: $(ollama --version)" Green
        return
    }
    Write-Step "`[Prereq] Ollama not found. Downloading installer..." Yellow
    $installerPath = "$env:TEMP\ollama-installer.exe"
    $ollamaUrl = 'https://ollama.com/download/OllamaSetup.exe'
    try {
        Invoke-WebRequest -Uri $ollamaUrl -OutFile $installerPath -UseBasicParsing
        Write-Step '        Running installer (follow the prompts)...' Gray
        Start-Process $installerPath -Wait
        Remove-Item $installerPath -ErrorAction SilentlyContinue
        $env:PATH = [System.Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' +
        [System.Environment]::GetEnvironmentVariable('PATH', 'User')
        if (Get-Command ollama -ErrorAction SilentlyContinue) {
            Write-Step "        Ollama installed: $(ollama --version)" Green
        }
        else {
            Write-Step '        Ollama installed but not in PATH yet - restart this terminal.' Yellow
        }
    }
    catch {
        Write-Host "        Download failed: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host '        Install manually from https://ollama.com/download/windows' -ForegroundColor Red
        throw
    }
}

function Ensure-Node {
    if (Get-Command node -ErrorAction SilentlyContinue) {
        Write-Step "`[Prereq] Node.js already installed: $(node --version)" Green
        return
    }
    Write-Step "`[Prereq] Node.js not found. Downloading LTS MSI..." Yellow
    try {
        $nodeIndex = Invoke-RestMethod 'https://nodejs.org/dist/index.json' -UseBasicParsing
        $lts = $nodeIndex | Where-Object { $_.lts } | Select-Object -First 1
        $nodeVersion = $lts.version
        $nodeUrl = "https://nodejs.org/dist/$nodeVersion/node-$nodeVersion-x64.msi"
        $nodeMsi = "$env:TEMP\node-installer.msi"
        Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeMsi -UseBasicParsing
        Write-Step "        Installing Node.js $nodeVersion..." Gray
        Start-Process msiexec -ArgumentList "/i `"$nodeMsi`" /qn" -Wait
        Remove-Item $nodeMsi -ErrorAction SilentlyContinue
        $env:PATH = [System.Environment]::GetEnvironmentVariable('PATH', 'Machine') + ';' +
        [System.Environment]::GetEnvironmentVariable('PATH', 'User')
        if (Get-Command node -ErrorAction SilentlyContinue) {
            Write-Step "        Node.js installed: $(node --version)" Green
        }
        else {
            Write-Step '        Node.js installed - restart terminal to use it.' Yellow
        }
    }
    catch {
        Write-Host "        Download failed: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host '        Install manually from https://nodejs.org (LTS)' -ForegroundColor Red
        throw
    }
}

function Ensure-GpuEnv {
    $pairs = @{
        'OLLAMA_GPU_OVERHEAD'   = '0'
        'CUDA_VISIBLE_DEVICES'  = '0'
        'OLLAMA_NUM_GPU_LAYERS' = '99'
    }
    $changed = $false
    foreach ($kv in $pairs.GetEnumerator()) {
        $cur = [System.Environment]::GetEnvironmentVariable($kv.Key, 'User')
        if ($cur -ne $kv.Value) {
            [System.Environment]::SetEnvironmentVariable($kv.Key, $kv.Value, 'User')
            Write-Step "`[Env] Set $($kv.Key)=$($kv.Value) (User)" Green
            $changed = $true
        }
    }
    if (-not $changed) {
        Write-Step "`[Env] GPU-related User env vars already correct" Green
    }
}

function Ensure-Models {
    if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
        Write-Step "`[Models] Ollama not available - skip pulls" Yellow
        return
    }
    foreach ($m in $ModelsToPull) {
        if (Test-OllamaModelPresent $m) {
            Write-Step "`[Models] Already present: $m" Green
        }
        else {
            Write-Step "`[Models] Pulling $m ..." Yellow
            & ollama pull $m
            if ($LASTEXITCODE -ne 0) {
                Write-Host "        Pull failed for $m (exit $LASTEXITCODE)" -ForegroundColor Red
            }
        }
    }
}

function Ensure-AnthropicBaseUrl {
    # Match merge-claude-hybrid-env.js (127.0.0.1 avoids IPv6 localhost issues; same port as ROUTER_PORT).
    $port = $env:ROUTER_PORT
    if (-not $port) { $port = '8082' }
    $want = "http://127.0.0.1:$port"
    $cur = [System.Environment]::GetEnvironmentVariable('ANTHROPIC_BASE_URL', 'User')
    if ($cur -eq $want) {
        Write-Step "`[Routing] ANTHROPIC_BASE_URL already $want" Green
    }
    else {
        [System.Environment]::SetEnvironmentVariable('ANTHROPIC_BASE_URL', $want, 'User')
        Write-Step "`[Routing] ANTHROPIC_BASE_URL set to $want (User)" Green
    }
}

function Ensure-HybridRouterConfigFile {
    $example = Join-Path $ProjectDir 'router\hybrid.config.example.json'
    $target = Join-Path $ProjectDir 'router\hybrid.config.json'
    if (-not (Test-Path $target) -and (Test-Path $example)) {
        Copy-Item -Path $example -Destination $target -Force
        Write-Step "`[Config] Created router\hybrid.config.json from example (edit model / routing)" Green
    }
    elseif (Test-Path $target) {
        Write-Step "`[Config] router\hybrid.config.json already present" Green
    }
}

function Get-PreferredRouterTimeZone {
    try {
        $id = (Get-TimeZone).Id
    }
    catch {
        return $null
    }
    $map = @{
        'Eastern Standard Time'      = 'America/Toronto'
        'Atlantic Standard Time'     = 'America/Halifax'
        'Newfoundland Standard Time' = 'America/St_Johns'
        'Central Standard Time'      = 'America/Winnipeg'
        'Mountain Standard Time'     = 'America/Edmonton'
        'Pacific Standard Time'      = 'America/Vancouver'
    }
    if ($map.ContainsKey($id)) { return $map[$id] }
    return $null
}

function Ensure-RouterTimeZoneConfig {
    $target = Join-Path $ProjectDir 'router\hybrid.config.json'
    if (-not (Test-Path $target)) { return }
    $timeZone = Get-PreferredRouterTimeZone
    if (-not $timeZone) {
        Write-Step "`[Config] Router time zone not mapped from Windows; runtime will use local system time" Gray
        return
    }
    try {
        $raw = Get-Content $target -Raw
        $obj = if ($raw.Trim()) { $raw | ConvertFrom-Json } else { [pscustomobject]@{} }
    }
    catch {
        Write-Step "`[Config] Could not read router\hybrid.config.json to set time zone" Yellow
        return
    }
    if (-not (Get-Member -InputObject $obj -Name display -ErrorAction SilentlyContinue)) {
        Add-Member -InputObject $obj -MemberType NoteProperty -Name display -Value ([pscustomobject]@{})
    }
    $current = ''
    try { $current = [string]$obj.display.time_zone } catch { $current = '' }
    if ($current -and $current.Trim() -ne '') {
        Write-Step "`[Config] Router time zone already set: $current" Green
        return
    }
    try {
        if (-not (Get-Member -InputObject $obj.display -Name time_zone -ErrorAction SilentlyContinue)) {
            Add-Member -InputObject $obj.display -MemberType NoteProperty -Name time_zone -Value $timeZone
        }
        else {
            $obj.display.time_zone = $timeZone
        }
        $json = $obj | ConvertTo-Json -Depth 16
        [System.IO.File]::WriteAllText($target, $json + [Environment]::NewLine)
        Write-Step "`[Config] Router time zone set to $timeZone" Green
    }
    catch {
        Write-Step "`[Config] Failed to write router time zone: $($_.Exception.Message)" Yellow
    }
}

function Ensure-ClaudeSettingsHybridEnv {
    $merge = Join-Path $ProjectDir 'scripts\merge-claude-hybrid-env.js'
    if (-not (Test-Path $merge)) {
        Write-Step "`[Claude] merge script missing: $merge" Yellow
        return
    }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Step "`[Claude] Node not in PATH - skip settings.json merge" Yellow
        return
    }
    try {
        if (-not $env:ROUTER_PORT -or $env:ROUTER_PORT -eq '') { $env:ROUTER_PORT = '8082' }
        $out = & node $merge 2>&1
        foreach ($line in $out) { Write-Step "        $line" Gray }
    }
    catch {
        Write-Step "`[Claude] settings merge failed: $($_.Exception.Message)" Yellow
    }
}

function Ensure-AnthropicApiKey {
    $existing = [System.Environment]::GetEnvironmentVariable('ANTHROPIC_API_KEY', 'User')
    if ($existing) {
        Write-Step "`[Routing] ANTHROPIC_API_KEY already set" Green
        return
    }
    if ($NonInteractive) {
        Write-Step "`[Routing] ANTHROPIC_API_KEY not set - skipped (-NonInteractive). Cloud fallback disabled until set." Yellow
        return
    }
    Write-Host ''
    Write-Step "`[Routing] ANTHROPIC_API_KEY is not set (needed for cloud fallback)." Yellow
    $key = Read-Host '        Paste Anthropic API key (sk-ant-...) or Enter to skip'
    if ($key) {
        [System.Environment]::SetEnvironmentVariable('ANTHROPIC_API_KEY', $key.Trim(), 'User')
        Write-Step '        API key saved (User).' Green
    }
    else {
        Write-Step '        Skipped - cloud fallback will not work until you set the key.' Red
    }
}

function Get-ExpectedVbsContent([string]$setupPath) {
    return @"
' Silently runs the Claude Hybrid Router at Windows login
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -WindowStyle Hidden -NonInteractive -ExecutionPolicy Bypass -File ""$setupPath"" -Autostart", 0, False
"@
}

function Ensure-StartupVbs {
    if (-not (Test-Path $SetupPs)) {
        Write-Step "`[Startup] Missing setup.ps1 - cannot create VBS launcher" Red
        return
    }
    $expected = (Get-ExpectedVbsContent $SetupPs).TrimEnd()
    $write = $true
    if (Test-Path $VbsPath) {
        try {
            $existing = (Get-Content -Path $VbsPath -Raw -ErrorAction Stop).TrimEnd()
            if ($existing -eq $expected) {
                Write-Step "`[Startup] Startup VBS already up to date: $VbsPath" Green
                $write = $false
            }
        }
        catch {
            $write = $true
        }
    }
    if ($write) {
        try {
            $tmpPath = "$VbsPath.tmp"
            [System.IO.File]::WriteAllText($tmpPath, $expected + "`r`n", [System.Text.Encoding]::ASCII)
            Move-Item -Path $tmpPath -Destination $VbsPath -Force
            Write-Step "`[Startup] Wrote Startup launcher: $VbsPath" Green
        }
        catch {
            Write-Host "  `[Startup] Failed: $($_.Exception.Message)" -ForegroundColor Red
        }
    }
}

function Ensure-RootShortcut {
    if (-not (Test-Path $SetupPs)) {
        Write-Step "`[Shortcut] Missing setup.ps1" Red
        return
    }
    try {
        $shell = New-Object -ComObject WScript.Shell
        $sc = $shell.CreateShortcut($ShortcutLnk)
        $sc.TargetPath = $PsExe
        $sc.Arguments = "-WindowStyle Hidden -NonInteractive -ExecutionPolicy Bypass -File `"$SetupPs`" -Autostart"
        $sc.WorkingDirectory = $ProjectDir
        $sc.Description = 'Start Ollama (if needed) and Claude Hybrid router at Windows login'
        $sc.Save()
        Write-Step "`[Shortcut] Root shortcut: $ShortcutLnk (copy to Startup if you prefer .lnk over VBS)" Green
    }
    catch {
        Write-Host "  `[Shortcut] Failed: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

function Invoke-AutostartIfNeeded {
    if (Test-PortListening 8082) {
        Write-Step "`[Run] Router already listening on :8082 - skip daemon start" Green
        return
    }
    if (-not (Test-Path (Join-Path $ProjectDir 'router\server.js'))) {
        Write-Step "`[Run] router\server.js not found" Yellow
        return
    }
    Write-Step "`[Run] Starting Ollama + router..." Yellow
    Invoke-AutostartDaemon
    Start-Sleep -Seconds 2
}

function Ensure-WatchdogTask {
    $watchdogScript = "$ProjectDir\scripts\create-watchdog-task.ps1"
    if (-not (Test-Path $watchdogScript)) {
        Write-Step "`[Watchdog] Script not found: $watchdogScript" Yellow
        return
    }

    Write-Step "`[Watchdog] Refreshing auto-restart watchdog task..." Yellow
    try {
        & $watchdogScript
        Write-Step "`[Watchdog] Scheduled task is up to date" Green
    }
    catch {
        Write-Step "`[Watchdog] Failed to register: $($_.Exception.Message)" Yellow
    }
}

# --- Entry ---

if ($Autostart) {
    Ensure-WatchdogTask
    Invoke-AutostartDaemon
    exit 0
}

if ($ShortcutOnly) {
    Write-Host ''
    Write-Host '  Claude Hybrid - startup shortcut only' -ForegroundColor Cyan
    Write-Host '  -----------------------------------------' -ForegroundColor DarkGray
    Ensure-RootShortcut
    Write-Host ''
    Write-Host '  Copy to Startup folder if desired:' -ForegroundColor Cyan
    Write-Host "    $StartupFolder" -ForegroundColor White
    Write-Host '  (Win+R -> shell:startup)' -ForegroundColor Gray
    Write-Host ''
    exit 0
}

Write-Host ''
Write-Host '  Claude Hybrid - Setup' -ForegroundColor Cyan
Write-Host '  -----------------------------------------' -ForegroundColor DarkGray
Write-Host ''

if (-not $RoutingOnly) {
    Ensure-Ollama
    Ensure-Node
    Ensure-GpuEnv
    Ensure-Models
}
else {
    Write-Step "`[Mode] -RoutingOnly: skipping Ollama/Node/GPU env/model pulls" Gray
}

Ensure-AnthropicBaseUrl
Ensure-AnthropicApiKey
Ensure-ClaudeSettingsHybridEnv
Ensure-HybridRouterConfigFile
Ensure-RouterTimeZoneConfig
Ensure-StartupVbs
Ensure-RootShortcut
Ensure-WatchdogTask

Invoke-AutostartIfNeeded

Write-Host ''
Write-Host '  Done.' -ForegroundColor Cyan
if (-not $RoutingOnly) {
    Write-Host '  New terminals: use Claude Code / claude with hybrid routing.' -ForegroundColor Gray
}
Write-Host "  Optional .lnk (copy to Startup): $ShortcutLnk" -ForegroundColor DarkGray
Write-Host ''

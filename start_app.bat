@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

:: ============================================================
:: Claude Hybrid Router — start_app.bat
:: Checks Node, Ollama (install if missing), starts Ollama
:: service if needed, auto-pulls a model if library is empty,
:: applies hybrid env, then launches router/server.js.
:: ============================================================

:: ------------------------------------------------------------
:: Section 1 — Repo sanity check
:: ------------------------------------------------------------
if not exist "package.json" (
  echo ERROR: package.json not found. Keep this file in the Claude-Hybrid repo root.
  exit /b 1
)

:: ------------------------------------------------------------
:: Section 2 — Node.js check
:: ------------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: node not found in PATH. Install Node.js 18+ or restart after install.
  exit /b 1
)

:: ------------------------------------------------------------
:: Section 3 — Ollama detection (PATH, then known install dir)
:: ------------------------------------------------------------
echo.
echo [1/4] Checking Ollama installation...

set "OLLAMA_EXE="

:: Check PATH first
where ollama >nul 2>&1
if not errorlevel 1 (
  set "OLLAMA_EXE=ollama"
  goto :ollama_found
)

:: Check default Windows install location
if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" (
  set "OLLAMA_EXE=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"
  :: Add to PATH for this session so subsequent calls work without full path
  set "PATH=%LOCALAPPDATA%\Programs\Ollama;%PATH%"
  echo   Ollama found at %LOCALAPPDATA%\Programs\Ollama\ollama.exe
  echo   Added to PATH for this session.
  goto :ollama_found
)

:: ------------------------------------------------------------
:: Section 3a — Ollama not found: download and install silently
:: ------------------------------------------------------------
echo   Ollama not found. Downloading installer...
echo   This is a one-time ~60 MB download from https://ollama.com
echo.

set "OLLAMA_INSTALLER=%TEMP%\OllamaSetup.exe"

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ProgressPreference = 'Continue'; " ^
  "Write-Host '  Downloading OllamaSetup.exe...'; " ^
  "Invoke-WebRequest -Uri 'https://ollama.com/download/OllamaSetup.exe' " ^
  "  -OutFile '%OLLAMA_INSTALLER%' " ^
  "  -UseBasicParsing"

if not exist "%OLLAMA_INSTALLER%" (
  echo ERROR: Download failed. Check your internet connection and try again.
  echo   You can also install Ollama manually from https://ollama.com/download
  exit /b 1
)

echo.
echo   Running OllamaSetup.exe /S (silent install)...
"%OLLAMA_INSTALLER%" /S
:: Wait for installer to finish (it runs synchronously with /S)
timeout /t 5 /nobreak >nul

:: Re-check after install
if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" (
  set "OLLAMA_EXE=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"
  set "PATH=%LOCALAPPDATA%\Programs\Ollama;%PATH%"
  echo   Ollama installed successfully.
  echo   NOTE: Open a new terminal after this session for Ollama to be in PATH permanently.
  goto :ollama_found
)

:: Final fallback — check PATH again (some installers add to PATH immediately)
where ollama >nul 2>&1
if not errorlevel 1 (
  set "OLLAMA_EXE=ollama"
  echo   Ollama installed and available in PATH.
  goto :ollama_found
)

echo ERROR: Ollama installation appears to have failed or requires a restart.
echo   Try running OllamaSetup.exe manually from %OLLAMA_INSTALLER%
echo   then re-run start_app.bat.
exit /b 1

:ollama_found
echo   Ollama is available.

:: ------------------------------------------------------------
:: Section 4 — Ollama service check: ensure `ollama serve` is up
:: ------------------------------------------------------------
echo.
echo [2/4] Checking Ollama service...

ollama list >nul 2>&1
if not errorlevel 1 (
  echo   Ollama service is running.
  goto :ollama_service_ok
)

echo   Ollama service is not running. Starting it in the background...
if not defined OLLAMA_MAX_LOADED_MODELS set "OLLAMA_MAX_LOADED_MODELS=2"
echo   Ollama max loaded models: %OLLAMA_MAX_LOADED_MODELS%
start /B "" ollama serve >nul 2>&1
echo   Waiting ~4 seconds for service to initialize...
timeout /t 4 /nobreak >nul

:: Retry check
ollama list >nul 2>&1
if not errorlevel 1 (
  echo   Ollama service started successfully.
  goto :ollama_service_ok
)

echo WARNING: Could not verify Ollama service after start attempt.
echo   Continuing anyway — the router will surface an error if Ollama is unreachable.

:ollama_service_ok

:: ------------------------------------------------------------
:: Section 5 — Auto-pull model if library is empty
:: ------------------------------------------------------------
echo.
echo [3/4] Checking Ollama model library...

:: Capture `ollama list` output, skip header line, look for any data rows.
:: We count non-empty lines after the header. Use a temp file to avoid
:: piping issues with EnableDelayedExpansion inside for/do blocks.
set "OLLAMA_LIST_TMP=%TEMP%\ollama_list_check.txt"
ollama list 2>nul > "%OLLAMA_LIST_TMP%"

set "OLLAMA_MODEL_COUNT=0"
set "OLLAMA_SKIP_HEADER=1"
for /f "usebackq delims=" %%L in ("%OLLAMA_LIST_TMP%") do (
  if "!OLLAMA_SKIP_HEADER!"=="1" (
    :: First line is the column header — skip it
    set "OLLAMA_SKIP_HEADER=0"
  ) else (
    :: Any subsequent non-empty line is a model entry
    set "LINE_CONTENT=%%L"
    if not "!LINE_CONTENT!"=="" (
      set /a OLLAMA_MODEL_COUNT+=1
    )
  )
)
if exist "%OLLAMA_LIST_TMP%" del "%OLLAMA_LIST_TMP%"

if !OLLAMA_MODEL_COUNT! GTR 0 (
  echo   Model library is not empty ^(!OLLAMA_MODEL_COUNT! model^(s^) found^). Skipping auto-pull.
  goto :ollama_models_ok
)

:: No models found — pull a sensible default for Claude Code routing
echo.
echo   No models found in Ollama library.
echo   Pulling qwen2.5-coder:7b — this is a one-time download of ~4.7 GB.
echo.
echo   Why qwen2.5-coder:7b?
echo     - Optimized for coding tasks ^(the primary use case for Claude Code routing^)
echo     - Strong performance-per-GB ratio for local inference
echo     - Fits comfortably in 8 GB+ VRAM or runs on CPU with sufficient RAM
echo     - Used by the router for lightweight/local requests so cloud API calls
echo       are reserved for complex or large-context tasks
echo.
echo   Pulling now ^(live progress below^)...
echo   ----------------------------------------------------------------
ollama pull qwen2.5-coder:7b
if errorlevel 1 (
  echo.
  echo WARNING: ollama pull failed. The router can still start, but local
  echo   routing will not work until at least one model is available.
  echo   Run: ollama pull qwen2.5-coder:7b   (once Ollama is healthy^)
) else (
  echo   ----------------------------------------------------------------
  echo   Model pulled successfully.
)

:ollama_models_ok

:: ------------------------------------------------------------
:: Section 6 — Port conflict / already-running check
:: ------------------------------------------------------------
echo.
echo [4/4] Checking port %ROUTER_PORT% and starting router...

if "%ROUTER_PORT%"=="" set "ROUTER_PORT=8082"
set "PORT_PID="
for /f "tokens=5" %%P in ('netstat -ano 2^>nul ^| findstr "LISTENING" ^| findstr ":%ROUTER_PORT% "') do (
  set "PORT_PID=%%P"
  goto :port_check_done
)

:port_check_done
if defined PORT_PID (
  set "PORT_IMG="
  for /f "tokens=1 delims=," %%I in ('tasklist /FI "PID eq %PORT_PID%" /FO CSV /NH 2^>nul') do set "PORT_IMG=%%~I"

  :: Health-check: is it our router responding healthy?
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:%ROUTER_PORT%/api/health' -TimeoutSec 2; if ($r.status -eq 'healthy') { exit 0 } } catch {}; exit 1" >nul 2>&1
  if not errorlevel 1 (
    echo   Claude Hybrid router is already listening on port %ROUTER_PORT% ^(PID %PORT_PID%^).
    echo   Syncing hybrid env ^(merge-claude-hybrid-env^)...
    node "%~dp0scripts\merge-claude-hybrid-env.js"
    if errorlevel 1 (
      echo ERROR: merge-claude-hybrid-env.js failed while router is already running.
      echo   Run: npm run merge-env   then retry.
      exit /b 1
    )
    exit /b 0
  )

  :: node.exe on that port — assume it's our router even if health check timed out
  if /I "!PORT_IMG!"=="node.exe" (
    echo   Claude Hybrid router appears to be starting on port %ROUTER_PORT% ^(PID %PORT_PID%^).
    echo   Syncing hybrid env ^(merge-claude-hybrid-env^)...
    node "%~dp0scripts\merge-claude-hybrid-env.js"
    if errorlevel 1 (
      echo ERROR: merge-claude-hybrid-env.js failed while router is already running.
      echo   Run: npm run merge-env   then retry.
      exit /b 1
    )
    exit /b 0
  )

  echo ERROR: Port %ROUTER_PORT% is already in use by PID %PORT_PID% ^(!PORT_IMG!^).
  echo   Stop the process or run stop_app.bat, then try again.
  exit /b 1
)

:: ------------------------------------------------------------
:: Section 7 — Merge env and launch router
:: ------------------------------------------------------------
echo   Applying hybrid routing: ANTHROPIC_BASE_URL -^> http://127.0.0.1:%ROUTER_PORT%
echo   ^(Claude settings, User env, IDE terminals^)...
node "%~dp0scripts\merge-claude-hybrid-env.js"
if errorlevel 1 (
  echo WARNING: merge-claude-hybrid-env.js failed. Starting router anyway; run npm run merge-env manually.
)

echo.
echo   Starting Claude Hybrid Router ^(node router\server.js^) on port %ROUTER_PORT%...
echo   Dashboard: http://127.0.0.1:%ROUTER_PORT%/
echo   Press Ctrl+C to stop. After exit, run stop_app.bat to restore cloud routing.
echo.
node "%~dp0router\server.js"
exit /b %ERRORLEVEL%

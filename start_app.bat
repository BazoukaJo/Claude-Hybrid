@echo off
setlocal EnableExtensions
cd /d "%~dp0"

if not exist "package.json" (
  echo ERROR: package.json not found. Keep this file in the Claude-Hybrid repo root.
  exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: node not found in PATH. Install Node.js 18+ or restart after install.
  exit /b 1
)

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
  if /I "%PORT_IMG%"=="node.exe" (
    echo Claude Hybrid router is already listening on port %ROUTER_PORT% ^(PID %PORT_PID%^).
    echo Syncing hybrid env ^(merge-claude-hybrid-env^)...
    node "%~dp0scripts\merge-claude-hybrid-env.js"
    if errorlevel 1 (
      echo ERROR: merge-claude-hybrid-env.js failed while router is already running.
      echo Run npm run merge-env manually, then retry.
      exit /b 1
    )
    exit /b 0
  )
  echo ERROR: Port %ROUTER_PORT% is already in use by PID %PORT_PID% ^(%PORT_IMG%^).
  echo Stop the process or run stop_app.bat, then try again.
  exit /b 1
)

echo Applying hybrid routing: ANTHROPIC_BASE_URL -^> http://127.0.0.1:%ROUTER_PORT% ^(Claude settings, User env, IDE terminals^)...
node "%~dp0scripts\merge-claude-hybrid-env.js"
if errorlevel 1 (
  echo WARNING: merge-claude-hybrid-env.js failed. Starting router anyway; run npm run merge-env manually.
)

echo Starting Claude Hybrid Router (node router\server.js) on port %ROUTER_PORT% in this window...
echo Press Ctrl+C to stop the server. After exit, run stop_app.bat to point Claude back at cloud.
node "%~dp0router\server.js"
exit /b %ERRORLEVEL%

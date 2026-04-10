@echo off
setlocal EnableExtensions
cd /d "%~dp0"

if not exist "package.json" (
  echo ERROR: package.json not found. Keep this file in the Claude-Hybrid repo root.
  pause
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo ERROR: npm not found in PATH. Install Node.js 18+ or restart after install.
  pause
  exit /b 1
)

if "%ROUTER_PORT%"=="" set "ROUTER_PORT=8082"
netstat -ano 2>nul | findstr ":%ROUTER_PORT%" | findstr "LISTENING" >nul
if not errorlevel 1 (
  echo Claude Hybrid router already listening on port %ROUTER_PORT%.
  exit /b 0
)

echo Starting Claude Hybrid Router ^(npm start^) on port %ROUTER_PORT% in this window...
echo Press Ctrl+C to stop the server.
call npm start
exit /b %ERRORLEVEL%

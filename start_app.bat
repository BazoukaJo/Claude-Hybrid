@echo off
setlocal EnableExtensions
cd /d "%~dp0"

if not exist "package.json" (
  echo ERROR: package.json not found. Keep this file in the Claude-Hybrid repo root.
  pause
  exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: node not found in PATH. Install Node.js 18+ or restart after install.
  pause
  exit /b 1
)

if "%ROUTER_PORT%"=="" set "ROUTER_PORT=8082"
REM Match LISTENING lines for this port only (space after port avoids matching e.g. :80820)
netstat -ano 2>nul | findstr "LISTENING" | findstr ":%ROUTER_PORT% " >nul
if not errorlevel 1 (
  echo Claude Hybrid router already listening on port %ROUTER_PORT%.
  echo To see which process holds it: netstat -ano ^| findstr LISTENING ^| findstr ":%ROUTER_PORT% "
  exit /b 0
)

echo Starting Claude Hybrid Router (node router\server.js) on port %ROUTER_PORT% in this window...
echo Press Ctrl+C to stop the server.
node "%~dp0router\server.js"
exit /b %ERRORLEVEL%

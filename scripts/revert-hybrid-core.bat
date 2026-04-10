@echo off
REM Chained revert: Claude settings.json (kit URL) + Windows User env (ANTHROPIC_BASE_URL, optional GPU kit defaults).
REM Invoked by: stop_app.bat revert
setlocal
cd /d "%~dp0.."
node scripts\revert-claude-hybrid-env.js
if errorlevel 1 exit /b 1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0revert-hybrid-user-env.ps1"
exit /b %ERRORLEVEL%

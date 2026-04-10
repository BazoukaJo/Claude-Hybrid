@echo off
REM Shared env + settings.json revert (used by revert_hybrid_env.bat and stop_app.bat revert).
setlocal EnableExtensions
set "SCRIPT_DIR=%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%revert-hybrid-user-env.ps1"
if errorlevel 1 exit /b 1

if exist "%SCRIPT_DIR%revert-claude-hybrid-env.js" (
  where node >nul 2>&1
  if errorlevel 1 (
    echo Node not in PATH — skipped settings.json revert. Run: node scripts\revert-claude-hybrid-env.js
    exit /b 0
  )
  node "%SCRIPT_DIR%revert-claude-hybrid-env.js"
) else (
  echo scripts\revert-claude-hybrid-env.js missing.
)

exit /b 0

@echo off
REM Creates "Claude Hybrid Router.lnk" in your Windows Startup folder (Win+R: shell:startup).
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\create-startup-shortcut.ps1"
if errorlevel 1 (
  pause
  exit /b 1
)
echo.
pause

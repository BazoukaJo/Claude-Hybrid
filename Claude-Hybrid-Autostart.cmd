@echo off
REM Optional double-click launcher; same logic as the Startup shortcut (hidden PowerShell).
cd /d "%~dp0"
powershell.exe -WindowStyle Hidden -NonInteractive -ExecutionPolicy Bypass -File "%~dp0setup.ps1" -Autostart

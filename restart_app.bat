@echo off
setlocal EnableExtensions
cd /d "%~dp0"

call "%~dp0stop_app.bat"
REM ping delay avoids "Input redirection is not supported" from timeout.exe in some hosts
ping -n 3 127.0.0.1 >nul 2>&1
call "%~dp0start_app.bat"

exit /b 0

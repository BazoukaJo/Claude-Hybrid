@echo off
setlocal EnableExtensions
cd /d "%~dp0"

if "%ROUTER_PORT%"=="" set "ROUTER_PORT=8082"

set "STOP_EC=0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-listener-on-port.ps1" -Port %ROUTER_PORT%
if errorlevel 1 set "STOP_EC=1"

REM Optional: also clear hybrid routing env — only when explicitly requested:
REM   stop_app.bat revert
if /I "%~1"=="revert" goto :do_revert
goto :end

:do_revert
echo.
echo Reverting hybrid User env + Claude settings.json...
call "%~dp0scripts\revert-hybrid-core.bat"
if errorlevel 1 set "STOP_EC=1"

:end
exit /b %STOP_EC%

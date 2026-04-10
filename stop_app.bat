@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

if "%ROUTER_PORT%"=="" set "ROUTER_PORT=8082"

set "STOP_EC=0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-listener-on-port.ps1" -Port %ROUTER_PORT%
if errorlevel 1 set "STOP_EC=1"

set "N=0"
:wait_loop
netstat -ano 2>nul | findstr "LISTENING" | findstr ":%ROUTER_PORT% " >nul
if errorlevel 1 goto :wait_done
set /a N+=1
if !N! GEQ 25 goto :wait_failed
ping -n 2 127.0.0.1 >nul 2>&1
goto wait_loop

:wait_failed
echo ERROR: Port %ROUTER_PORT% is still listening after stop attempt.
netstat -ano 2>nul | findstr "LISTENING" | findstr ":%ROUTER_PORT% "
set "STOP_EC=1"

:wait_done

REM Optional: also clear hybrid routing env only when explicitly requested:
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

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

REM By default clear kit proxy so Claude Code uses Anthropic cloud when the router is down.
REM Use: stop_app.bat keepenv  to stop only and leave ANTHROPIC_BASE_URL / settings unchanged.
if /I "%~1"=="keepenv" goto :end

echo.
echo Clearing hybrid proxy ^(Claude settings.json, VS Code terminal env, User ANTHROPIC_BASE_URL^)...
echo Claude Code will use cloud until you start the router again ^(start_app.bat runs merge-env^).
call "%~dp0scripts\revert-hybrid-core.bat"
if errorlevel 1 set "STOP_EC=1"

:end
exit /b %STOP_EC%

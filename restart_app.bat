@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
if "%ROUTER_PORT%"=="" set "ROUTER_PORT=8082"

call "%~dp0stop_app.bat" keepenv
set "STOP_EC=!ERRORLEVEL!"
call :wait_port_free
if errorlevel 1 (
  echo.
  echo Restart failed: port %ROUTER_PORT% is still in use after stop ^(stop_app exit !STOP_EC!^).
  echo Close the router or the app using that port, then try again.
  exit /b 1
)

call "%~dp0start_app.bat"
exit /b !ERRORLEVEL!

REM Wait until netstat shows no LISTENER on ROUTER_PORT (handles slow socket release)
:wait_port_free
set "N=0"
:wait_loop
netstat -ano 2>nul | findstr "LISTENING" | findstr ":%ROUTER_PORT% " >nul
if errorlevel 1 (
  if !N! GTR 0 echo Port %ROUTER_PORT% is free.
  exit /b 0
)
set /a N+=1
if !N! GEQ 30 exit /b 1
if !N! EQU 1 echo Waiting for port %ROUTER_PORT% to be released...
ping -n 2 127.0.0.1 >nul 2>&1
goto wait_loop

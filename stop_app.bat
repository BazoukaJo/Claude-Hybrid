@echo off
setlocal EnableExtensions
cd /d "%~dp0"

if "%ROUTER_PORT%"=="" set "ROUTER_PORT=8082"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p=[int]$env:ROUTER_PORT; if(-not$p){$p=8082}; " ^
  "$conns=Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue; " ^
  "if(-not$conns){Write-Host ('Nothing listening on port '+$p+'.'); exit 0}; " ^
  "$ids=$conns|Select-Object -ExpandProperty OwningProcess -Unique; " ^
  "foreach($id in $ids){ try{ Stop-Process -Id $id -Force -ErrorAction Stop; Write-Host ('Stopped PID '+$id+'.') } catch{ Write-Host ('Could not stop PID '+$id+': '+$_.Exception.Message) } }"

exit /b %ERRORLEVEL%

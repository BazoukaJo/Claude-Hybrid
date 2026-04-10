@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo.
echo  Revert Claude Hybrid — stop router, User env, Claude settings.json
echo  (ANTHROPIC_API_KEY is not removed.)
echo.

call "%~dp0stop_app.bat"
if errorlevel 1 (
  echo Router stop reported an error; continuing with env revert.
)

call "%~dp0scripts\revert-hybrid-core.bat"
if errorlevel 1 (
  echo Revert step failed.
  exit /b 1
)

echo.
echo Restart terminals and your IDE so they pick up removed variables.
pause
exit /b 0

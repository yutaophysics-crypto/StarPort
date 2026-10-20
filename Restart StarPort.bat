@echo off
chcp 65001 >nul
echo Restarting StarPort after running conversations have finished...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\restart-hub.ps1"
if errorlevel 1 (
  echo Restart failed. See .data\restart.log.
  pause
  exit /b 1
)
echo.
echo Finished. Refresh http://127.0.0.1:3210/ in your browser.
pause

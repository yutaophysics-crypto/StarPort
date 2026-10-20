@echo off
chcp 65001 >nul
echo Optional database maintenance: checkpoint and compact StarPort's database.
echo Conversation deletion does not run this maintenance automatically.
echo Delete only the intended conversations in StarPort before running this tool.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\purge-hub.ps1"
if errorlevel 1 (
  echo Maintenance failed. See .data\purge.log.
  pause
  exit /b 1
)
echo.
echo Finished. Refresh http://127.0.0.1:3210/ in your browser.
pause

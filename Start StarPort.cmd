@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-and-launch.ps1" %*
if errorlevel 1 (
  echo.
  echo StarPort could not start. See the message above and README.md.
  pause
  exit /b 1
)

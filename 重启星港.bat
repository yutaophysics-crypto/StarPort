@echo off
chcp 65001 >nul
echo 正在重启星港：等待运行中的对话结束，然后换上新代码…
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\restart-hub.ps1"
echo.
echo 已完成。请回到浏览器刷新 http://127.0.0.1:3210/
pause

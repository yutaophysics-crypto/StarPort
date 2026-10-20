@echo off
chcp 65001 >nul
echo 星港已在删除对话时自动物理清除（checkpoint + VACUUM）。
echo 本脚本保留为手动整理旧残留的备用入口，无需在每次删除后运行。
echo 运行前请先在星港界面里删除要删的对话。
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\purge-hub.ps1"
echo.
echo 已完成。请回到浏览器刷新 http://127.0.0.1:3210/
pause

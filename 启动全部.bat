@echo off
setlocal
cd /d "%~dp0"
chcp 65001 >nul
title NapCat + Whale-chan 一键启动

echo ================================================
echo   Whale-chan 完整启动（NapCat + 机器人）
echo ================================================
echo.

set "QQDIR=D:\Program Files\Tencent\QQNT"
set "NAPCATDIR=%QQDIR%\versions\9.9.33-52230\resources\app\napcat"

if not exist "%QQDIR%\QQ.exe" (
  echo [错误] 未找到 QQ：%QQDIR%\QQ.exe
  echo 请确认 QQ 9.9.33 已安装到该路径。
  pause
  exit /b 1
)

if not exist "%NAPCATDIR%\napcat.mjs" (
  echo [错误] 未找到 NapCat：%NAPCATDIR%
  pause
  exit /b 1
)

echo [1/2] 启动 NapCat（会拉起 QQ，首次需扫码）
taskkill /f /im QQ.exe >nul 2>&1
timeout /t 2 >nul

set "NAPCAT_PATCH_PACKAGE=%NAPCATDIR%\qqnt.json"
set "NAPCAT_LOAD_PATH=%NAPCATDIR%\loadNapCat.js"
set "NAPCAT_MAIN_PATH=%NAPCATDIR%\napcat.mjs"
start "" /min "%NAPCATDIR%\NapCatWinBootMain.exe" "%QQDIR%\QQ.exe" "%NAPCATDIR%\NapCatWinBootHook.dll"

echo     等待 QQ 登录并开放 3001 端口...
timeout /t 25 >nul

echo.
echo [2/2] 启动 Whale-chan 机器人
echo.
echo 提示：群聊需要 @ 机器人才会回复
echo       配置界面：双击 start-config-ui.bat
echo.
node dist\index.js
echo.
echo 机器人已退出
pause

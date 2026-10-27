@echo off
setlocal
cd /d "%~dp0"
chcp 65001 >nul
title Whale-chan

echo ================================================
echo   Whale-chan 机器人启动器
echo ================================================
echo.

if not exist node_modules (
  echo [1/2] 首次运行，正在安装依赖...
  call pnpm install
  if errorlevel 1 (
    echo [错误] 依赖安装失败，请先安装 Node.js 22+ 与 pnpm
    pause
    exit /b 1
  )
)

if not exist dist\index.js (
  echo [2/2] 正在编译...
  call pnpm build
  if errorlevel 1 ( echo [错误] 编译失败 & pause & exit /b 1 )
)

echo.
echo 正在启动机器人... 按 Ctrl+C 退出
echo 提示：需要协议端监听 3001（NapCat 正向 WebSocket）
echo.

node dist\index.js
echo.
echo 机器人已退出
pause

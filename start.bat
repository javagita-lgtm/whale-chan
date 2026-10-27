@echo off
setlocal
cd /d "%~dp0"
chcp 65001 >nul
title Whale-chan
echo ================================================
echo   Whale-chan 一键启动
echo ================================================
echo.
if not exist node_modules (
  echo [1/2] 首次运行，正在安装依赖（需要联网，约 2 分钟）...
  call pnpm install
  if errorlevel 1 (
    echo.
    echo [错误] 依赖安装失败。请先安装 Node.js 22+ 和 pnpm。
    echo   Node.js: https://nodejs.org/
    echo   pnpm:    在命令行运行  npm install -g pnpm
    pause
    exit /b 1
  )
)
if not exist dist\index.js (
  echo [2/2] 编译中...
  call pnpm build
)
echo.
echo 启动机器人... 按 Ctrl+C 退出
echo 提示：需要 NapCat 已启动并监听 3001 端口
echo.
node dist\index.js
echo.
echo 机器人已退出。
pause

@echo off
setlocal
cd /d "%~dp0"
chcp 65001 >nul
title Whale-chan 配置界面
if not exist node_modules (
  echo 首次运行，正在安装依赖...
  call pnpm install
  if errorlevel 1 ( echo [错误] 安装失败 & pause & exit /b 1 )
)
echo 配置界面：http://127.0.0.1:8787
echo 按 Ctrl+C 退出
start "" http://127.0.0.1:8787
node node_modules\tsx\dist\cli.mjs src/web/index.ts
pause

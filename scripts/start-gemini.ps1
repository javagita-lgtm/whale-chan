# 启动 Gemini 生图适配层（5052）
#
# 为什么必须用 Start-Process -RedirectStandardOutput 而不是管道：
#   之前踩过——用 `pwsh ... | Select-Object` 启动，工具返回后管道被关闭，
#   进程后续任何 print() 都抛 [Errno 22]，表现为"端口开着但接口全 500"。
#
# 依赖：
#   - Python 环境要有 gemini_webapi + flask
#   - 代理 socks5h://127.0.0.1:10808 必须可用（Gemini 直连不通）
#   - scripts/gemini-cookies.json 里有 __Secure-1PSID

param(
    [string]$Root = 'E:\PRO\etc\daliy\whale-chan',
    [string]$Python = 'E:\comfyUI\.venv\Scripts\python.exe',
    [int]$Port = 5052
)

$ErrorActionPreference = 'Stop'

$Server  = Join-Path $Root 'scripts\gemini_server.py'
$LogDir  = Join-Path $Root 'logs'
$Log     = Join-Path $LogDir 'gemini-server.log'
$Err     = Join-Path $LogDir 'gemini-server.err'
$CacheDir = Join-Path $Root 'data\gemini-cookies'

if (-not (Test-Path $Python)) { throw "缺少 Python: $Python" }
if (-not (Test-Path $Server)) { throw "缺少适配层脚本: $Server" }
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }
if (-not (Test-Path $CacheDir)) { New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null }

# 已在跑就跳过
if (Test-NetConnection 127.0.0.1 -Port $Port -InformationLevel Quiet -WarningAction SilentlyContinue) {
    Write-Host "Gemini 适配层已在监听 $Port，跳过启动"
    exit 0
}

# 检查代理（Gemini 直连不通，代理挂了启动也没意义）
$proxyOk = Test-NetConnection 127.0.0.1 -Port 10808 -InformationLevel Quiet -WarningAction SilentlyContinue
if (-not $proxyOk) {
    Write-Host '警告：代理 10808 未监听，Gemini 出图会失败' -ForegroundColor Yellow
}

# 检查 cookie
$cookieFile = Join-Path $Root 'scripts\gemini-cookies.json'
if (-not (Test-Path $cookieFile)) {
    Write-Host '警告：缺少 scripts/gemini-cookies.json，出图会失败' -ForegroundColor Yellow
}

# cookie 缓存必须持久化：默认在 %TEMP%，重启就没了
$env:GEMINI_COOKIE_PATH = $CacheDir
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUTF8 = '1'

# 用文件重定向，绝不能用管道。
#
# 注意：不能用 Start-Process -Environment —— 那是 PowerShell 7+ 才有的参数，
# 本机 watchdog 用的是 powershell.exe (5.1)，会报
#   "A parameter cannot be found that matches parameter name 'Environment'"
# 所以这里靠 $env: 设置（会被子进程继承），再用 Start-Process 起进程。
Start-Process -FilePath $Python `
    -ArgumentList @($Server) `
    -WorkingDirectory $Root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $Log `
    -RedirectStandardError $Err | Out-Null

Write-Host "已启动，日志: $Log"

# 等它起来（Flask 启动快，但要 import gemini_webapi）
for ($i = 1; $i -le 10; $i++) {
    Start-Sleep -Seconds 2
    if (Test-NetConnection 127.0.0.1 -Port $Port -InformationLevel Quiet -WarningAction SilentlyContinue) {
        Write-Host "Gemini 适配层已就绪（${i}x2 秒）"
        exit 0
    }
}

Write-Host '启动超时，检查日志：' -ForegroundColor Red
if (Test-Path $Err) { Get-Content $Err -Tail 15 }
exit 1

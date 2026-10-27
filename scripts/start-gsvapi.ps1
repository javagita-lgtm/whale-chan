# 启动 GPT-SoVITS 原生 API（9880）
#
# 为什么必须用 Start-Process -RedirectStandardOutput 而不是管道：
#   之前用 `pwsh ... | Select-Object` 启动，工具返回后管道被关闭，
#   进程后续任何 print() 都会抛 [Errno 22] Invalid argument，
#   表现为 /tts 接口 500（合成失败），但端口还活着，极难排查。
#
# 为什么不用 PYTHONUTF8 环境变量：
#   runtime 是 Python 3.9，某些情况下设 PYTHONUTF8=1 会报
#   "Fatal Python error: preconfig_init_utf8_mode: invalid PYTHONUTF8"。
#   改用 PYTHONIOENCODING=utf-8 即可。

$ErrorActionPreference = 'Stop'

$Root   = 'E:\GPT-SoVITS\GPT-SoVITS-v4-20250422fix'
$Py     = Join-Path $Root 'runtime\python.exe'
$LogDir = 'E:\PRO\etc\daliy\whale-chan\logs'
$Log    = Join-Path $LogDir 'gsvapi.log'
$Err    = Join-Path $LogDir 'gsvapi.err'

if (-not (Test-Path $Py)) { throw "缺少 GPT-SoVITS runtime: $Py" }
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }

# 已在跑就跳过
$up = Test-NetConnection 127.0.0.1 -Port 9880 -InformationLevel Quiet -WarningAction SilentlyContinue
if ($up) {
    Write-Host '9880 已在监听，跳过启动'
    exit 0
}

$env:PYTHONIOENCODING = 'utf-8'

# 用文件重定向，绝不能用管道（会关掉 stdout）
Start-Process -FilePath $Py `
    -ArgumentList @('api_v2.py', '-a', '127.0.0.1', '-p', '9880') `
    -WorkingDirectory $Root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $Log `
    -RedirectStandardError $Err | Out-Null

Write-Host "已在后台启动，日志: $Log"

# 等它加载好（BERT + GPT + SoVITS 约 30~50 秒）
for ($i = 1; $i -le 12; $i++) {
    Start-Sleep -Seconds 5
    if (Test-NetConnection 127.0.0.1 -Port 9880 -InformationLevel Quiet -WarningAction SilentlyContinue) {
        Write-Host "9880 已开放（${i}x5 秒）"
        exit 0
    }
}

Write-Host '启动超时，检查日志：'
if (Test-Path $Err) { Get-Content $Err -Tail 20 }
exit 1

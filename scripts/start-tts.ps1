# 启动 TTS 全套服务
#
# 两套后端并存，机器人通过 TTS_BASE_URL 选一个：
#   5050 = Style-Bert-VITS2（SBV2，中文萌系，音色用独立模型文件）
#   5051 = GPT-SoVITS 适配层（零样本克隆，速度快、更像人）
#   9880 = GPT-SoVITS 原生 API（5051 依赖它）
#
# 为什么要适配层：
#   GPT-SoVITS 原生 API 要求每次请求都带「参考音频 + 参考文本」，
#   没有统一的音色概念。5051 把「参考音频」抽象成音色配置，
#   接口和 SBV2 保持一致，机器人侧不用改代码。

$ErrorActionPreference = 'Stop'

$PyTts   = 'E:\tts-venv\Scripts\python.exe'
$Root    = 'E:\PRO\etc\daliy\whale-chan'
$LogDir  = Join-Path $Root 'logs'

$GsvRoot = 'E:\GPT-SoVITS\GPT-SoVITS-v4-20250422fix'
$GsvPy   = Join-Path $GsvRoot 'runtime\python.exe'

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }
$stamp = Get-Date -Format 'yyyyMMdd'

# ---------- 1. GPT-SoVITS 原生 API（9880）----------
if (Test-Path $GsvPy) {
    $port9880 = Test-NetConnection 127.0.0.1 -Port 9880 -InformationLevel Quiet -WarningAction SilentlyContinue
    if (-not $port9880) {
        Write-Host '启动 GPT-SoVITS 原生 API（9880）'
        Start-Process -FilePath $GsvPy `
            -ArgumentList @('api_v2.py', '-a', '127.0.0.1', '-p', '9880') `
            -WorkingDirectory $GsvRoot `
            -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $LogDir "gptsovits-$stamp.log") `
            -RedirectStandardError (Join-Path $LogDir "gptsovits-$stamp.err") | Out-Null
        # 要加载 BERT + GPT + SoVITS，约 25 秒
        Start-Sleep -Seconds 30
    } else {
        Write-Host 'GPT-SoVITS 原生 API 已在运行'
    }
} else {
    Write-Host "缺少 GPT-SoVITS 环境: $GsvPy"
}

if (Test-Path $PyTts) {
    # ---------- 2. GSV 适配层（5051）----------
    $port5051 = Test-NetConnection 127.0.0.1 -Port 5051 -InformationLevel Quiet -WarningAction SilentlyContinue
    if (-not $port5051) {
        Write-Host '启动 GSV 适配层（5051）'
        Start-Process -FilePath $PyTts `
            -ArgumentList @((Join-Path $Root 'scripts\gsv_server.py')) `
            -WorkingDirectory $Root `
            -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $LogDir "gsv-adapter-$stamp.log") `
            -RedirectStandardError (Join-Path $LogDir "gsv-adapter-$stamp.err") | Out-Null
        Start-Sleep -Seconds 6
    } else {
        Write-Host 'GSV 适配层已在运行'
    }

    # ---------- 3. SBV2（5050，备用）----------
    $port5050 = Test-NetConnection 127.0.0.1 -Port 5050 -InformationLevel Quiet -WarningAction SilentlyContinue
    if (-not $port5050) {
        Write-Host '启动 SBV2（5050）'
        Start-Process -FilePath $PyTts `
            -ArgumentList @((Join-Path $Root 'scripts\tts_server.py')) `
            -WorkingDirectory $Root `
            -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $LogDir "tts-$stamp.log") `
            -RedirectStandardError (Join-Path $LogDir "tts-$stamp.err") | Out-Null
        Start-Sleep -Seconds 6
    } else {
        Write-Host 'SBV2 已在运行'
    }
}

Write-Host 'TTS 服务启动完成'

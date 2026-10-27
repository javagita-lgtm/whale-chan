# Whale-chan 守护进程
#
# 职责：让「QQ(NapCat) + 机器人」长期活着。
# 策略：每轮先检查，缺什么补什么；全部健康就睡一会再来。
#
# 设计要点：
#   - 单实例：命名 Mutex 保证同一时刻只有一个 watchdog 干活，
#     计划任务重复触发也安全。
#   - 分而治之：QQ 必须由 NapCat 启动器拉起（注入 hook）；
#     机器人是普通 node 进程，两者分别检查、分别拉起。
#   - 不折腾扫码：QQ 进程还在但端口没开时，判定为"等扫码"，
#     绝不反复杀启，否则二维码一直刷新永远扫不上。
#   - 日志按天切分，保留 7 天。
#
# 注意：本文件必须保存为 UTF-8 with BOM。
# 不加 BOM 时 Windows PowerShell 5.1 会按 ANSI 读，中文字符串被截断，
# 导致花括号解析失败（报 Missing closing brace）。

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# ---------- 路径常量 ----------
# 全部可通过环境变量覆盖，便于换机器/换用户时不用改脚本。
# 不设环境变量时按脚本自身位置推导，保证「解压即用」。
$Root = if ($env:WHALE_ROOT) { $env:WHALE_ROOT } else { Split-Path -Parent $PSScriptRoot }

# Node 运行时优先用独立版本，但**必须放在高完整性级别目录**（如用户目录）。
# 实测：同一个 node.exe 放在 E:\PRO\etc\daliy\runtime 时，
# 进程会以「低完整性级别（Low IL）」运行，无法往 C 盘 TEMP 创建目录（EPERM），
# 导致本地 whisper 转写直接失败。详见 B站深读说明.md「低完整性级别」一节。
$RuntimeDir = if ($env:WHALE_NODE_RUNTIME) { $env:WHALE_NODE_RUNTIME } else { '' }
$NodeExe    = if ($RuntimeDir) { Join-Path $RuntimeDir 'node.exe' } else { 'node' }

# QQ / NapCat 路径随安装位置不同，必须可配置
$QQDir     = if ($env:WHALE_QQ_DIR) { $env:WHALE_QQ_DIR } else { '' }
$NapCatDir = if ($QQDir -and $env:WHALE_NAPCAT_VER) {
    Join-Path $QQDir "versions\$($env:WHALE_NAPCAT_VER)\resources\app\napcat"
} else { '' }
$Launcher  = if ($NapCatDir) { Join-Path $NapCatDir 'NapCatWinBootMain.exe' } else { '' }

$LogDir     = Join-Path $Root 'logs'
$BotEntry   = Join-Path $Root 'dist\index.js'
$BotLog     = Join-Path $Root 'bot.log'

# 控制面板「停止机器人」时写的暂停标记。存在则说明是人工停的，
# watchdog 不得擅自拉起，否则用户刚点停止、20 秒后又被拉回来。
$PauseFlag  = Join-Path $Root 'data\.bot-paused'

# 行为参数
$CheckIntervalSec = 20      # 每轮检查间隔
$BotStartGraceSec = 30      # 机器人启动后给多久算"起来了"
$QqStartGraceSec  = 90      # NapCat/QQ 登录给多久
$MaxBotRestarts   = 5       # 连续失败上限，超过则退避
$BotBackoffMaxSec = 300     # 退避上限

# ---------- 日志 ----------
function Initialize-Log {
    if (-not (Test-Path $LogDir)) {
        New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    }
    Get-ChildItem $LogDir -Filter '*.log' -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) } |
        Remove-Item -Force -ErrorAction SilentlyContinue
}

function Write-Log {
    param(
        [string]$Message,
        [ValidateSet('INFO', 'WARN', 'ERROR', 'OK')]
        [string]$Level = 'INFO'
    )
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $line  = "[$stamp][$Level] $Message"
    Write-Host $line
    $file = Join-Path $LogDir ("watchdog-{0}.log" -f (Get-Date -Format 'yyyyMMdd'))
    Add-Content -Path $file -Value $line -Encoding UTF8
}

# ---------- 单实例 ----------
$script:Mutex = $null

function Enter-SingleInstance {
    $created = $false
    $script:Mutex = New-Object System.Threading.Mutex($true, 'Global\WhaleChanWatchdog', [ref]$created)
    if (-not $created) {
        Write-Host '已有 watchdog 在运行，本实例退出。'
        exit 0
    }
}

# ---------- 进程探测 ----------
function Get-BotProcess {
    # 靠命令行特征识别；括号不能省，-and 优先级高于 -or
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and (
                $_.CommandLine -like '*dist\index.js*' -or
                $_.CommandLine -like '*dist/index.js*'
            )
        } |
        Select-Object -First 1
}

function Get-NapCatLauncher {
    Get-CimInstance Win32_Process -Filter "Name='NapCatWinBootMain.exe'" -ErrorAction SilentlyContinue |
        Select-Object -First 1
}

function Test-PortOpen {
    param([int]$Port, [int]$TimeoutMs = 800)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $task = $client.ConnectAsync('127.0.0.1', $Port)
        if ($task.Wait($TimeoutMs) -and $client.Connected) { return $true }
        return $false
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Test-BotConnected {
    # 判断机器人是否真的连着 OneBot。
    #
    # 早期实现是「翻 bot.log 尾部找『已连接 OneBot』」，这是错的：
    # 日志是流水账，连上之后每来一条消息都会写新行，那条「已连接」很快就被
    # 挤出尾部窗口，于是明明连着却报「未连上」（实测 80 行日志时那条在第 5 行，
    # 而尾部窗口只有 60 行）。
    #
    # 正确做法：直接看机器人的 TCP 连接有没有指向 3001 的 ESTABLISHED。
    # 这是操作系统的事实，不受日志多少影响。
    $bot = Get-BotProcess
    if (-not $bot) { return $false }

    try {
        $conn = Get-NetTCPConnection -OwningProcess $bot.ProcessId -State Established -ErrorAction Stop |
            Where-Object { $_.RemotePort -eq 3001 }
        return [bool]$conn
    } catch {
        # Get-NetTCPConnection 不可用（极老系统）时退回日志判断，捡更长的窗口
        if (-not (Test-Path $BotLog)) { return $false }
        try {
            $tail = @(Get-Content $BotLog -Tail 300 -Encoding UTF8 -ErrorAction Stop)
            foreach ($line in $tail) {
                if ($line -match '已连接 OneBot') { return $true }
            }
        } catch { }
        return $false
    }
}

# ---------- 启动 ----------

# 日志轮转：bot.log 长期运行会一直涨（每条对话约 300 字节），
# 超过 5MB 就切成 .1 并把更老的删掉，最多留 2 个历史。
function Rotate-BotLog {
    param([string]$Path, [int]$MaxBytes = 5MB, [int]$Keep = 2)

    if (-not (Test-Path $Path)) { return }
    try {
        $size = (Get-Item $Path).Length
        if ($size -lt $MaxBytes) { return }

        # 旧的往后移：.2 -> 删，.1 -> .2，当前 -> .1
        for ($i = $Keep; $i -ge 1; $i--) {
            $src = if ($i -eq 1) { $Path } else { "$Path.$($i - 1)" }
            $dst = "$Path.$i"
            if (Test-Path $src) {
                if (Test-Path $dst) { Remove-Item $dst -Force -ErrorAction SilentlyContinue }
                Move-Item $src $dst -Force -ErrorAction SilentlyContinue
            }
        }
        Write-Log ("bot.log 已达 {0:N1} MB，已轮转到 {1}.1" -f ($size / 1MB), (Split-Path $Path -Leaf)) 'INFO'
    } catch {
        # 轮转失败不影响启动
    }
}

function Start-Bot {
    $errOut = Join-Path $Root 'bot.err'
    # 启动前先轮转：此时旧进程已退出，文件句柄已释放
    Rotate-BotLog -Path $BotLog
    Write-Log "启动机器人: $NodeExe `"$BotEntry`""
    $p = Start-Process -FilePath $NodeExe -ArgumentList $BotEntry -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $BotLog -RedirectStandardError $errOut -PassThru
    Write-Log "机器人已拉起 pid=$($p.Id)" 'OK'
    return $p
}

function Get-PanelProcess {
    # 控制面板由 tsx 启动，会派生父子两个 node 进程（launcher + 实际监听者），
    # 因此数量不可靠；权威判据始终是 8787 端口。
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -like '*web\index.ts*' } |
        Select-Object -First 1
}

function Test-PanelPort {
    Test-PortOpen -Port 8787 -TimeoutMs 400
}

function Start-Panel {
    $tsx = Join-Path $Root 'node_modules\tsx\dist\cli.mjs'
    if (-not (Test-Path $tsx)) {
        Write-Log "缺少 tsx，跳过控制面板: $tsx" 'WARN'
        return
    }
    $panelOut = Join-Path $Root 'web-panel.log'
    $panelErr = Join-Path $Root 'web-panel.err'
    Rotate-BotLog -Path $panelOut -MaxBytes 2MB -Keep 1
    $args2 = @($tsx, 'src/web/index.ts')
    Write-Log '启动控制面板（http://127.0.0.1:8787）'
    Start-Process -FilePath $NodeExe -ArgumentList $args2 -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $panelOut -RedirectStandardError $panelErr | Out-Null
    Write-Log '控制面板已拉起' 'OK'
}

# ComfyUI 生图服务（8188）
# 只在 .env 里 IMAGE_GEN_ENABLED=true 时才管理，避免没装环境时反复报错。
function Get-ImageGenEnabled {
    try {
        $envFile = Join-Path $Root '.env'
        if (-not (Test-Path $envFile)) { return $false }
        foreach ($line in (Get-Content $envFile -Encoding UTF8)) {
            if ($line -match '^\s*IMAGE_GEN_ENABLED\s*=\s*true\s*$') { return $true }
        }
    } catch { }
    return $false
}

function Test-ComfyPort {
    Test-PortOpen -Port 8188 -TimeoutMs 500
}

# 检测 ComfyUI 是否陷入"起来就崩"的循环。
# 背景：2026-10-25 遇到过一次——端口在听但一出图就 OSError 1455（页面文件太小），
# 进程崩溃后 watchdog 立即拉起，13 分钟内重启了 6 次。
# 只看端口是发现不了的，必须看崩溃记录。
function Test-ComfyCrashLoop {
    param([int]$WindowMinutes = 15, [int]$Threshold = 3)
    try {
        $since = (Get-Date).AddMinutes(-$WindowMinutes)
        $crashes = @(Get-WinEvent -FilterHashtable @{
            LogName   = 'Application'
            StartTime = $since
            Id        = 1000
        } -ErrorAction SilentlyContinue | Where-Object { $_.Message -match 'python\.exe' })
        return ($crashes.Count -ge $Threshold)
    } catch {
        return $false
    }
}

# TTS 语音合成服务（5050）
# 同样只在 .env 里 TTS_ENABLED=true 时管理。
function Get-TtsEnabled {
    try {
        $envFile = Join-Path $Root '.env'
        if (-not (Test-Path $envFile)) { return $false }
        foreach ($line in (Get-Content $envFile -Encoding UTF8)) {
            if ($line -match '^\s*TTS_ENABLED\s*=\s*true\s*$') { return $true }
        }
    } catch { }
    return $false
}

function Test-TtsPort {
    # 两个都必须活着：
    #   5051 = GSV 适配层（机器人调它）
    #   9880 = GPT-SoVITS 后端（适配层调它）
    # 只查 5051 不够——后端挂了适配层照样开着端口，
    # 表现为"面板显示就绪、但合成全失败"（2026-10-27 实际踩过）。
    return (Test-PortOpen -Port 5051 -TimeoutMs 500) -and (Test-PortOpen -Port 9880 -TimeoutMs 500)
}

function Start-Tts {
    # 先拉后端（它加载最慢，30~50 秒），再拉适配层
    $apiScript = Join-Path $Root 'scripts\start-gsvapi.ps1'
    if (Test-Path $apiScript) {
        if (-not (Test-PortOpen -Port 9880 -TimeoutMs 500)) {
            Write-Log '启动 GPT-SoVITS 后端（9880）'
            Start-Process -FilePath 'powershell.exe' `
                -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $apiScript) `
                -WindowStyle Hidden | Out-Null
            Write-Log '后端启动命令已发出' 'OK'
        }
    }

    $script = Join-Path $Root 'scripts\start-tts.ps1'
    if (-not (Test-Path $script)) {
        Write-Log "缺少 TTS 启动脚本: $script" 'WARN'
        return
    }
    Write-Log '启动 TTS 语音合成服务（5051 适配层）'
    Start-Process -FilePath 'powershell.exe' `
        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script) `
        -WindowStyle Hidden | Out-Null
    Write-Log 'TTS 启动命令已发出' 'OK'
}

function Start-ComfyUI {
    $script = Join-Path $Root 'scripts\start-comfyui.ps1'
    if (-not (Test-Path $script)) {
        Write-Log "缺少 ComfyUI 启动脚本: $script" 'WARN'
        return
    }
    Write-Log '启动 ComfyUI 生图服务（8188）'
    # 用 -NoProfile 起一个新 PowerShell，避免污染当前会话环境
    Start-Process -FilePath 'powershell.exe' `
        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script) `
        -WindowStyle Hidden | Out-Null
    Write-Log 'ComfyUI 启动命令已发出' 'OK'
}

function Start-NapCat {
    if (-not (Test-Path $Launcher)) {
        Write-Log "缺少 NapCat 启动器: $Launcher" 'ERROR'
        return
    }
    $qqExe = Join-Path $QQDir 'QQ.exe'
    if (-not (Test-Path $qqExe)) {
        Write-Log "缺少 QQ: $qqExe" 'ERROR'
        return
    }

    $env:NAPCAT_PATCH_PACKAGE = Join-Path $NapCatDir 'qqnt.json'
    $env:NAPCAT_LOAD_PATH     = Join-Path $NapCatDir 'loadNapCat.js'
    $env:NAPCAT_MAIN_PATH     = Join-Path $NapCatDir 'napcat.mjs'

    $hookDll = Join-Path $NapCatDir 'NapCatWinBootHook.dll'

    # -q <QQ号> 启用快速登录：复用本地登录票据，避免每次重启都要扫码。
    # 票据存在 Documents\Tencent Files\nt_qq\global\nt_data\login\ 下。
    # 腾讯风控仍可能要求验证，那时会退回二维码，不影响使用。
    # 号码取 .env 里的 BOT_SELF_ID；没配就退回扫码模式。
    $qqNumber = Get-BotSelfId
    if ($qqNumber) {
        $launchArgs = @(('"' + $qqExe + '"'), ('"' + $hookDll + '"'), '-q', $qqNumber)
        Write-Log "启动 NapCat（快速登录 $qqNumber；若需验证请扫码）"
    } else {
        $launchArgs = @(('"' + $qqExe + '"'), ('"' + $hookDll + '"'))
        Write-Log '启动 NapCat（未配置 BOT_SELF_ID，使用扫码登录）'
    }

    Start-Process -FilePath $Launcher -ArgumentList $launchArgs -WorkingDirectory $NapCatDir -WindowStyle Hidden
    Write-Log 'NapCat 启动器已拉起' 'OK'
}

# 从 .env 读 BOT_SELF_ID，供快速登录使用。
function Get-BotSelfId {
    try {
        $envFile = Join-Path $Root '.env'
        if (-not (Test-Path $envFile)) { return '' }
        foreach ($line in (Get-Content $envFile -Encoding UTF8)) {
            if ($line -match '^\s*BOT_SELF_ID\s*=\s*(\d+)\s*$') {
                return $Matches[1]
            }
        }
    } catch {
        # 读不到就当没配
    }
    return ''
}

# ---------- 主循环 ----------
function Invoke-Supervise {
    $botRestarts  = 0
    $lastBotStart = Get-Date
    $lastQqStart  = (Get-Date).AddMinutes(-10)
    $napcatWarned = $false
    # 面板刚拉起时给它时间监听端口，避免连拉多个实例
    $lastPanelStart = (Get-Date).AddMinutes(-10)
    # ComfyUI 启动要几十秒，冷却同理
    $lastComfyStart = (Get-Date).AddMinutes(-10)
    $imageGenEnabled = Get-ImageGenEnabled
    # TTS 启动要加载模型（17 秒），冷却给 120 秒
    $lastTtsStart = (Get-Date).AddMinutes(-10)
    $ttsEnabled = Get-TtsEnabled
    # Set-StrictMode 下读未定义变量会抛异常，必须先声明。
    # 用于"未连上"告警去重：只在状态翻转时记一行。
    $script:disconnectWarned = $false
    # 同理：人工暂停只提示一次
    $script:pausedNoticed = $false
    # ComfyUI 崩溃循环告警也只提示一次
    $script:comfyCrashNoticed = $false

    while (-not $false) {
        try {
            # ---- 机器人 ----
            $bot = Get-BotProcess

            # 控制面板点了「停止」：标记文件存在时不拉起，尊重人工意图
            if ((-not $bot) -and (Test-Path $PauseFlag)) {
                if (-not $script:pausedNoticed) {
                    Write-Log '机器人被人工停止（存在 .bot-paused 标记），暂停自动拉起' 'INFO'
                    $script:pausedNoticed = $true
                }
                Start-Sleep -Seconds $CheckIntervalSec
                continue
            }
            if (Test-Path $PauseFlag) { $script:pausedNoticed = $false }

            if (-not $bot) {
                if ($botRestarts -ge $MaxBotRestarts) {
                    $exp  = $botRestarts - $MaxBotRestarts + 1
                    $wait = [Math]::Min($BotBackoffMaxSec, [Math]::Pow(2, $exp) * 30)
                    Write-Log "机器人反复退出（$botRestarts 次），退避 ${wait}s" 'WARN'
                    Start-Sleep -Seconds $wait
                    $botRestarts = 0
                    continue
                }
                Write-Log '机器人未运行，拉起' 'WARN'
                Start-Bot | Out-Null
                $lastBotStart = Get-Date
                $botRestarts++
                Start-Sleep -Seconds $BotStartGraceSec
                continue
            }

            # 进程在且已稳定运行 → 这次启动算成功，重置计数
            $uptime = ((Get-Date) - $lastBotStart).TotalSeconds
            if ($uptime -gt 120) {
                if ($botRestarts -ne 0) {
                    Write-Log "机器人已稳定运行 $([Math]::Round($uptime))s，重置重启计数（原 $botRestarts）" 'OK'
                    $botRestarts = 0
                }

                # 未连上只在"状态翻转"时记一次，不要每轮刷屏。
                # 实测刷屏时 9 小时写了 1569 行全是同一句告警，把真正有用的日志全冲掉了。
                if (-not (Test-BotConnected)) {
                    if (-not $script:disconnectWarned) {
                        Write-Log '机器人运行中但未连上 OneBot，检查 NapCat / 3001' 'WARN'
                        $script:disconnectWarned = $true
                    }
                } elseif ($script:disconnectWarned) {
                    Write-Log '机器人已重新连上 OneBot，告警恢复' 'OK'
                    $script:disconnectWarned = $false
                }
            }

            # ---- NapCat / QQ ----
            $portOk = Test-PortOpen -Port 3001
            # 变量名不能叫 $launcher：PowerShell 变量不区分大小写，
            # 会覆盖脚本顶部的路径常量 $Launcher，导致 Start-NapCat 拿到 null。
            $launcherProc = Get-NapCatLauncher
            $qqProcs = @(Get-CimInstance Win32_Process -Filter "Name='QQ.exe'" -ErrorAction SilentlyContinue)
            $qqAlive = $qqProcs.Count -gt 0

            # 只有「完全没有任何 NapCat/QQ 痕迹」才重启。
            # QQ 进程活着说明可能正在等扫码，反复杀启会让二维码不停刷新。
            $napcatGone = (-not $portOk) -and (-not $launcherProc) -and (-not $qqAlive)

            if ($napcatGone) {
                $since = ((Get-Date) - $lastQqStart).TotalSeconds
                if ($since -gt 120) {
                    Write-Log 'NapCat / QQ 均未运行且 3001 未开放，重新拉起' 'WARN'
                    Start-NapCat
                    $lastQqStart = Get-Date
                    Start-Sleep -Seconds $QqStartGraceSec
                    continue
                }
            }

            if ((-not $portOk) -and ($launcherProc -or $qqAlive) -and (-not $napcatWarned)) {
                Write-Log 'NapCat/QQ 在跑但 3001 未开放 —— 若未登录请扫码（不会自动重启，以免二维码刷新）' 'WARN'
                $napcatWarned = $true
            }
            if ($portOk) { $napcatWarned = $false }

            # ---- 控制面板 ----
            # 面板只给人看，挂了不影响机器人收发，所以静默重拉。
            # 加 60 秒冷却：控制面板启动要几秒，没有冷却的话
            # 端口还没监听就被下一轮再拉一次，会堆出多个实例。
            $panelUp = Test-PanelPort
            if (-not $panelUp) {
                $sincePanel = ((Get-Date) - $lastPanelStart).TotalSeconds
                if ($sincePanel -gt 60) {
                    Start-Panel
                    $lastPanelStart = Get-Date
                    Start-Sleep -Seconds 6
                }
            }

            # ---- ComfyUI 生图服务 ----
            # 启动比面板慢得多（要加载 torch），所以冷却给 180 秒，
            # 否则会在它还没监听时反复拉起，吃满显存。
            if ($imageGenEnabled) {
                $comfyUp = Test-ComfyPort

                # 崩溃循环保护：15 分钟内崩了 3 次以上就停止重启并告警。
                # 2026-10-25 的教训：页面文件太小导致加载 SDXL 时 OSError 1455，
                # 进程崩溃 → watchdog 立即拉起 → 再崩，13 分钟重启了 6 次。
                # 这种情况重启是无效的，只会刷日志，必须让人看到真正的原因。
                if (-not $comfyUp -and (Test-ComfyCrashLoop)) {
                    if (-not $script:comfyCrashNoticed) {
                        Write-Log 'ComfyUI 15 分钟内崩溃 3 次以上，停止自动重启。请检查：内存/页面文件是否够（OSError 1455 就是这个问题）' 'ERROR'
                        $script:comfyCrashNoticed = $true
                    }
                } elseif (-not $comfyUp) {
                    $script:comfyCrashNoticed = $false
                    $sinceComfy = ((Get-Date) - $lastComfyStart).TotalSeconds
                    if ($sinceComfy -gt 180) {
                        Start-ComfyUI
                        $lastComfyStart = Get-Date
                        Start-Sleep -Seconds 10
                    }
                } else {
                    $script:comfyCrashNoticed = $false
                }
            }

            # ---- TTS 语音合成服务 ----
            # 它的模型加载要 17 秒 + BERT 16 秒，冷却给 120 秒。
            # Test-TtsPort 会同时检查 5051 适配层和 9880 后端。
            if ($ttsEnabled -and -not (Test-TtsPort)) {
                $sinceTts = ((Get-Date) - $lastTtsStart).TotalSeconds
                if ($sinceTts -gt 120) {
                    Start-Tts
                    $lastTtsStart = Get-Date
                    # 后端加载要 30~50 秒，等久一点再进下一轮
                    Start-Sleep -Seconds 45
                }
            }

        } catch {
            Write-Log "守护循环异常: $($_.Exception.Message)" 'ERROR'
        }

        Start-Sleep -Seconds $CheckIntervalSec
    }
}

# ---------- 入口 ----------
Initialize-Log
Enter-SingleInstance
Write-Log '===== watchdog 启动 ====='

if (-not (Test-Path $NodeExe)) {
    Write-Log "缺 node 运行时: $NodeExe（见 守护进程说明.md）" 'ERROR'
    exit 1
}
if (-not (Test-Path $BotEntry)) {
    Write-Log "缺机器人入口: $BotEntry（先执行 pnpm build）" 'ERROR'
    exit 1
}

try {
    Invoke-Supervise
} finally {
    if ($script:Mutex) {
        try { $script:Mutex.ReleaseMutex() } catch { }
        $script:Mutex.Dispose()
    }
}

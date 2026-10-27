# Whale-chan 守护进程状态速查
#
#   .\scripts\service-status.ps1
#
# 一次看清：计划任务是否注册、watchdog 是否在跑、QQ/NapCat/机器人各是什么状态。
#
# 注意：本文件必须保存为 UTF-8 with BOM（5.1 否则按 ANSI 读会乱码）。

$ErrorActionPreference = 'SilentlyContinue'

$Root   = Split-Path -Parent $PSScriptRoot
$QQDir  = 'D:\Program Files\Tencent\QQNT'
$BotLog = Join-Path $Root 'bot.log'

function Test-Port {
    param([int]$Port)
    $c = New-Object System.Net.Sockets.TcpClient
    try {
        $t = $c.ConnectAsync('127.0.0.1', $Port)
        if ($t.Wait(700) -and $c.Connected) { return $true }
        return $false
    } catch {
        return $false
    } finally {
        $c.Dispose()
    }
}

function Mark {
    param([bool]$Ok)
    if ($Ok) { return '[OK]' }
    return '[--]'
}

function Format-TaskResult {
    param([int]$Code)
    switch ($Code) {
        0x41300 { '就绪' }
        0x41301 { '正在运行' }
        0x41302 { '已禁用' }
        0x41303 { '从未运行' }
        0x41304 { '没有可运行实例' }
        0x41306 { '被用户终止' }
        0        { '成功' }
        default  { ('0x{0:X}' -f $Code) }
    }
}

Write-Host ''
Write-Host '===== Whale-chan 状态 =====' -ForegroundColor Cyan
Write-Host ''

# ---- 计划任务 ----
foreach ($name in @('WhaleChan-Watchdog', 'WhaleChan-Watchdog-Guard')) {
    $t = Get-ScheduledTask -TaskName $name
    if ($t) {
        $info  = Get-ScheduledTaskInfo -TaskName $name
        $state = [string]$t.State
        $color = 'Yellow'
        if ($state -eq 'Running') { $color = 'Green' }
        Write-Host ("任务 {0,-28} {1}" -f $name, $state) -ForegroundColor $color
        Write-Host ("     上次运行: {0}   结果: {1}" -f $info.LastRunTime, (Format-TaskResult $info.LastTaskResult))
    } else {
        Write-Host ("任务 {0,-28} 未注册" -f $name) -ForegroundColor DarkGray
    }
}

# ---- watchdog 进程 ----
$wd = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
        Where-Object { $_.CommandLine -like '*watchdog.ps1*' })

if ($wd.Count -gt 0) {
    foreach ($p in $wd) {
        $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
        if ($proc) {
            $mins = [Math]::Round(((Get-Date) - $proc.StartTime).TotalMinutes, 1)
            Write-Host ("watchdog 运行中 pid={0}  已运行 {1} 分钟" -f $p.ProcessId, $mins) -ForegroundColor Green
        }
    }
} else {
    Write-Host 'watchdog 未运行' -ForegroundColor Red
}

# ---- 各组件 ----
Write-Host ''
$qq     = @(Get-CimInstance Win32_Process -Filter "Name='QQ.exe'")
$nc     = @(Get-CimInstance Win32_Process -Filter "Name='NapCatWinBootMain.exe'")
$botPrc = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
            Where-Object {
                $_.CommandLine -and (
                    $_.CommandLine -like '*dist\index.js*' -or
                    $_.CommandLine -like '*dist/index.js*'
                )
            })
$p3001 = Test-Port 3001
$p6099 = Test-Port 6099

Write-Host ("{0} NapCat 启动器   进程数 {1}" -f (Mark ($nc.Count -gt 0)), $nc.Count)
Write-Host ("{0} QQ 进程         数量 {1}" -f (Mark ($qq.Count -gt 0)), $qq.Count)
$p3001Text = '未开放'
if ($p3001) { $p3001Text = '开放' }
Write-Host ("{0} OneBot 端口     3001 {1}" -f (Mark $p3001), $p3001Text)
$p6099Text = '未开放'
if ($p6099) { $p6099Text = '开放' }
Write-Host ("{0} NapCat WebUI    6099 {1}" -f (Mark $p6099), $p6099Text)
Write-Host ("{0} 机器人进程      数量 {1}" -f (Mark ($botPrc.Count -gt 0)), $botPrc.Count)

# ---- 机器人与 QQ 的连接 ----
# 用 TCP 连接判断，不用日志推断：日志是流水账，连上之后每来一条消息就写新行，
# 那条「已连接」很快被挤出尾部窗口，导致明明连着却报未连接。
$connected = $false
if ($botPrc.Count -gt 0) {
    $pid0 = $botPrc[0].ProcessId
    $conn = @(Get-NetTCPConnection -OwningProcess $pid0 -State Established -ErrorAction SilentlyContinue |
              Where-Object { $_.RemotePort -eq 3001 })
    $connected = $conn.Count -gt 0
}

if ($connected) {
    Write-Host '[OK] 机器人已连上 OneBot' -ForegroundColor Green
} elseif ($botPrc.Count -gt 0) {
    Write-Host '[!!] 机器人进程在，但到 3001 没有连接' -ForegroundColor Yellow
} else {
    Write-Host '[--] 机器人未运行' -ForegroundColor Red
}

# 登录身份从日志取（这只是展示信息，不影响判断）
if (Test-Path $BotLog) {
    $tail = @(Get-Content $BotLog -Tail 300 -Encoding UTF8)
    $who  = $tail | Select-String '登录身份确认' | Select-Object -Last 1
    if ($who -and $who.Line -match '"nickname":"([^"]+)"') {
        Write-Host ("     当前登录: {0}" -f $Matches[1])
    }
}

# ---- 守护日志 ----
$wdLog = Join-Path $Root ('logs\watchdog-{0}.log' -f (Get-Date -Format 'yyyyMMdd'))
Write-Host ''
if (Test-Path $wdLog) {
    Write-Host '--- 守护日志（最近 8 行）---' -ForegroundColor DarkGray
    Get-Content $wdLog -Tail 8 -Encoding UTF8 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
} else {
    Write-Host "(暂无守护日志：$wdLog)" -ForegroundColor DarkGray
}

Write-Host ''

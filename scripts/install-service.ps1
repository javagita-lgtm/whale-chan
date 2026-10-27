# 注册/更新 Whale-chan 守护进程的开机自启计划任务
#
# 用法（需管理员）：
#   .\scripts\install-service.ps1           # 安装或更新
#   .\scripts\install-service.ps1 -Remove   # 卸载
#
# 做两件事：
#   1. 建「开机启动」任务 —— 登录后立即拉起 watchdog
#   2. 建「每 10 分钟」看护任务 —— watchdog 被意外杀掉时补位
#
# 两个任务都只在 watchdog 不存在时才真正干活（单实例 Mutex 兜底），
# 所以重复触发是安全的。

param(
    [switch]$Remove,
    [string]$TaskName = 'WhaleChan-Watchdog'
)

$ErrorActionPreference = 'Stop'

$Root      = Split-Path -Parent $PSScriptRoot
$Watchdog  = Join-Path $Root 'scripts\watchdog.ps1'
$Runtime   = 'E:\PRO\etc\daliy\runtime\node-v22.22.2-win-x64\node.exe'
$WatchTask = "$TaskName"
$GuardTask = "$TaskName-Guard"

function Assert-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $pr = New-Object Security.Principal.WindowsPrincipal($id)
    if (-not $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw '需要管理员权限。请用「以管理员身份运行」打开 PowerShell 后重试。'
    }
}

function Remove-TaskIfExists {
    param([string]$Name)
    $existing = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $Name -Confirm:$false
        Write-Host "已删除任务: $Name" -ForegroundColor Yellow
    }
}

Assert-Admin

if ($Remove) {
    Remove-TaskIfExists $WatchTask
    Remove-TaskIfExists $GuardTask
    Write-Host "`n卸载完成。守护进程若仍在运行，请手动结束：" -ForegroundColor Green
    Write-Host '  Get-CimInstance Win32_Process -Filter "Name=''powershell.exe''" | Where-Object { $_.CommandLine -like "*watchdog.ps1*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }'
    exit 0
}

if (-not (Test-Path $Watchdog))  { throw "找不到守护脚本: $Watchdog" }
if (-not (Test-Path $Runtime))   { throw "找不到独立 node: $Runtime" }

$psArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Watchdog`""

# ---------- 任务 1：开机/登录即启动 ----------
$action1 = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $psArgs -WorkingDirectory $Root

$trigger1 = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$trigger1.Delay = 'PT20S'   # 等网络与桌面就绪，避免和 QQ 抢启动

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Days 0) `
    -MultipleInstances IgnoreNew `
    -Priority 4

$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Highest

Remove-TaskIfExists $WatchTask
Register-ScheduledTask -TaskName $WatchTask `
    -Description 'Whale-chan 守护进程：登录后自动拉起 QQ(NapCat) 与聊天机器人' `
    -Action $action1 -Trigger $trigger1 -Settings $settings -Principal $principal | Out-Null
Write-Host "已注册: $WatchTask（登录即启动，最高权限）" -ForegroundColor Green

# ---------- 任务 2：每 10 分钟看护 ----------
$action2 = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $psArgs -WorkingDirectory $Root
$trigger2 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
    -RepetitionInterval (New-TimeSpan -Minutes 10) `
    -RepetitionDuration (New-TimeSpan -Days 3650)

$settings2 = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Days 0) `
    -MultipleInstances IgnoreNew `
    -Priority 5

# 看护任务用 Limited，避免每次都要最高权限；它只负责补位拉起 watchdog
$principal2 = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Highest

Remove-TaskIfExists $GuardTask
Register-ScheduledTask -TaskName $GuardTask `
    -Description 'Whale-chan 看护：每 10 分钟检查守护进程是否存活，不存在则拉起' `
    -Action $action2 -Trigger $trigger2 -Settings $settings2 -Principal $principal2 | Out-Null
Write-Host "已注册: $GuardTask（每 10 分钟补位）" -ForegroundColor Green

Write-Host "`n===== 安装完成 =====" -ForegroundColor Cyan
Write-Host @"
立即启动（不用等下次登录）：
  Start-ScheduledTask -TaskName '$WatchTask'

查看状态：
  .\scripts\service-status.ps1

查看日志：
  Get-Content '$Root\logs\watchdog-$(Get-Date -Format 'yyyyMMdd').log' -Tail 30 -Wait

卸载：
  .\scripts\install-service.ps1 -Remove
"@

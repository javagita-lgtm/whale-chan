# 多线程分片下载大模型文件
#
# 为什么需要：HuggingFace 直连只有 0.09 MB/s，6.62GB 要 20 小时。
# 走本地 socks5 代理（xray，10808）能到 1 MB/s，再分片并发。
#
# 实现说明：
#   用 Start-Process 并行起多个 curl，而不是 Start-Job——
#   实测 Start-Job 里的子进程会丢失代理参数，导致所有分片都是 0 字节。

param(
    [string]$Url = 'https://huggingface.co/Laxhar/noobai-XL-Vpred-1.0/resolve/main/NoobAI-XL-Vpred-v1.0.safetensors',
    [string]$OutFile = 'E:\comfyUI\models\checkpoints\NoobAI-XL-Vpred-v1.0.safetensors',
    [int]$Threads = 8,
    [string]$Proxy = 'socks5h://127.0.0.1:10808'
)

$ErrorActionPreference = 'Stop'
$curl = 'curl.exe'

Write-Host "[1/3] 获取文件大小..."
$head = & $curl -sI -L --max-time 30 -x $Proxy $Url
$lenLine = $head -split "`n" | Where-Object { $_ -match '^content-length:' } | Select-Object -Last 1
if (-not $lenLine) { throw '无法获取文件大小' }
$total = [long](($lenLine -split ':')[1].Trim())
"  总大小: {0:N2} GB" -f ($total / 1GB)

$chunk = [long][Math]::Ceiling($total / $Threads)
$partDir = "$OutFile.parts"
New-Item -ItemType Directory -Force -Path $partDir | Out-Null

Write-Host "[2/3] 启动 $Threads 个分片下载（代理 $Proxy）..."

$procs = @()
for ($i = 0; $i -lt $Threads; $i++) {
    $start = $i * $chunk
    $end = [Math]::Min($total - 1, ($i + 1) * $chunk - 1)
    $partFile = Join-Path $partDir "part$i.bin"
    $want = $end - $start + 1

    if ((Test-Path $partFile) -and ((Get-Item $partFile).Length -eq $want)) {
        Write-Host "  分片 $i 已完成，跳过"
        continue
    }
    if (Test-Path $partFile) { Remove-Item $partFile -Force }

    $p = Start-Process -FilePath $curl `
        -ArgumentList @(
            '-L', '-s', '--max-time', '7200',
            '-x', $Proxy,
            '-r', "$start-$end",
            '-o', "`"$partFile`"",
            "`"$Url`""
        ) `
        -PassThru -WindowStyle Hidden
    $procs += @{ Proc = $p; Index = $i; Want = $want; File = $partFile }
    $mb = [math]::Round($want/1MB)
    Write-Host "  分片 $i : $mb MB  pid=$($p.Id)"
}

Write-Host "[3/3] 等待下载完成..."
$sw = [Diagnostics.Stopwatch]::StartNew()
while ($true) {
    $running = @($procs | Where-Object { -not $_.Proc.HasExited })
    $done = 0
    foreach ($item in $procs) {
        if (Test-Path $item.File) { $done += (Get-Item $item.File).Length }
    }
    $pct = if ($total -gt 0) { $done / $total * 100 } else { 0 }
    Write-Host ("  {0:N0}/{1:N0} MB ({2:N1}%)  剩余 {3} 个进程  已用 {4:N0} 分钟" -f `
        ($done/1MB), ($total/1MB), $pct, $running.Count, ($sw.Elapsed.TotalMinutes))

    if ($running.Count -eq 0) { break }
    Start-Sleep -Seconds 15
}
$sw.Stop()

Write-Host "`n检查分片完整性..."
$missing = @()
foreach ($item in $procs) {
    $got = if (Test-Path $item.File) { (Get-Item $item.File).Length } else { 0 }
    if ($got -ne $item.Want) { $missing += "分片$($item.Index) 期望$($item.Want) 实际$got" }
}
if ($missing.Count -gt 0) {
    Write-Host "  ❌ 分片不完整：" -ForegroundColor Red
    $missing | ForEach-Object { Write-Host "     $_" }
    exit 1
}

Write-Host "  全部完整，开始拼接..."
$out = [System.IO.File]::Create($OutFile)
for ($i = 0; $i -lt $Threads; $i++) {
    $partFile = Join-Path $partDir "part$i.bin"
    $in = [System.IO.File]::OpenRead($partFile)
    $in.CopyTo($out)
    $in.Close()
    Write-Host "  已拼接分片 $i"
}
$out.Close()

$final = (Get-Item $OutFile).Length
"`n完成: {0:N2} GB (期望 {1:N2} GB)" -f ($final/1GB), ($total/1GB)
if ($final -eq $total) {
    Write-Host "OK 大小校验通过" -ForegroundColor Green
    Remove-Item $partDir -Recurse -Force
} else {
    Write-Host "FAIL 大小不符，保留分片供排查" -ForegroundColor Red
    exit 1
}

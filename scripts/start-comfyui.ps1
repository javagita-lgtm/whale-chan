# 启动 ComfyUI 生图服务（无窗口，供 watchdog 调用）
#
# 为什么不用桌面版 ComfyUI.exe：
#   它的 Python 环境（Documents\ComfyUI\.venv）已被删除，启动后静默退出；
#   而且 Electron 应用需要桌面会话，窗口一关就退出，不适合常驻。
#
# 这里直接用 Python 跑标准 ComfyUI 源码，纯后台、可被监控、支持 /free 卸载显存。

$ErrorActionPreference = 'Stop'

$Venv     = 'E:\comfyUI\.venv\Scripts\python.exe'
$Src      = 'E:\comfy\ComfyUI\resources\ComfyUI\main.py'
$ModelCfg = 'E:\comfyUI\extra_model_paths.yaml'
$WorkDir  = 'E:\comfy\ComfyUI\resources\ComfyUI'
$LogDir   = 'E:\PRO\etc\daliy\whale-chan\logs'

if (-not (Test-Path $Venv)) { throw "缺少 Python 环境: $Venv（需先运行 setup）" }
if (-not (Test-Path $Src))  { throw "缺少 ComfyUI 源码: $Src" }
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }

$stamp = Get-Date -Format 'yyyyMMdd'
$out = Join-Path $LogDir "comfyui-$stamp.log"
$err = Join-Path $LogDir "comfyui-$stamp.err"

$args = @(
    $Src,
    '--listen', '127.0.0.1',
    '--port', '8188',
    '--preview-method', 'none',
    '--extra-model-paths-config', $ModelCfg,
    # output/input/temp 必须单独指定：extra_model_paths.yaml 里的 output 键
    # 只影响资源搜索路径，不会改变 SaveImage 的写入位置。
    '--output-directory', 'E:\comfyUI\output',
    '--input-directory',  'E:\comfyUI\input',
    '--temp-directory',   'E:\comfyUI\temp'
)

Start-Process -FilePath $Venv `
    -ArgumentList $args `
    -WorkingDirectory $WorkDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput $out `
    -RedirectStandardError $err | Out-Null

Write-Host "ComfyUI 已启动，日志: $out"

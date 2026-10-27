"""用 GPT-SoVITS 自带的 UVR5 分离人声和伴奏。

为什么用 GPT-SoVITS 的 runtime：
  svc-venv 里没装 bs_roformer，而 GPT-SoVITS 整合包自带
  tools/uvr5/bs_roformer + uvr5_weights 全套。

用法：
    python separate_vocals.py <输入音频> <输出目录>
输出：
    <输出目录>/vocals.wav   人声
    <输出目录>/inst.wav     伴奏
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path


def _duration(p: Path) -> float:
    """取音频时长（秒）。"""
    try:
        r = subprocess.run(
            ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
             '-of', 'csv=p=0', str(p)],
            capture_output=True, text=True, timeout=30,
        )
        return float(r.stdout.strip())
    except Exception:  # noqa: BLE001
        return 0.0

ROOT = Path(r'E:\GPT-SoVITS\GPT-SoVITS-v4-20250422fix')
sys.path.insert(0, str(ROOT))
# bsroformer.py 里是 `from bs_roformer.bs_roformer import ...`（顶层导入），
# 所以必须把这个目录也加进 sys.path
sys.path.insert(0, str(ROOT / 'tools' / 'uvr5'))

WEIGHTS = ROOT / 'tools/uvr5/uvr5_weights'
MODEL = 'model_bs_roformer_ep_317_sdr_12.9755'


def main() -> int:
    if len(sys.argv) < 3:
        print('用法: python separate_vocals.py <输入音频> <输出目录>')
        return 1

    src = Path(sys.argv[1])
    out = Path(sys.argv[2])

    if not src.exists():
        print(f'输入不存在: {src}')
        return 1

    out.mkdir(parents=True, exist_ok=True)
    tmp = out / '_raw'
    tmp.mkdir(exist_ok=True)

    from tools.uvr5.bsroformer import Roformer_Loader

    # bs_roformer 的 run_folder 用 librosa.load(mono=False) 读音频，
    # 单声道会返回 1D 数组，后面 nn.functional.pad(mode="reflect")
    # 要求 >=3D 维度，直接抛：
    #   NotImplementedError: Only 2D,3D,4D,5D padding ...
    # 所以喂进去之前一定要转成**立体声（2D）**。
    # （4 分钟那首能成功，正是因为它本身是立体声。）
    stereo = tmp / '_stereo.wav'
    subprocess.run(
        ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
         '-i', str(src), '-ac', '2', str(stereo)],
        check=True,
    )
    src_for_sep = stereo

    print(f'加载 UVR5 模型: {MODEL}', flush=True)
    pre = Roformer_Loader(
        model_path=str(WEIGHTS / f'{MODEL}.ckpt'),
        config_path=str(WEIGHTS / f'{MODEL}.yaml'),
        device='cuda',
        is_half=True,
    )

    print(f'分离中: {src_for_sep.name}', flush=True)
    # _path_audio_(输入, 伴奏输出目录, 人声输出目录, 格式, is_hp3)
    pre._path_audio_(str(src_for_sep), str(tmp), str(tmp), 'wav', False)

    # 找输出：bs_roformer 会生成 <stem>_vocals.wav / <stem>_other.wav
    voc = next(tmp.glob('*vocal*'), None)
    inst = next(tmp.glob('*other*'), None) or next(tmp.glob('*instrument*'), None)

    if voc:
        shutil.copy2(voc, out / 'vocals.wav')
        print(f'  人声: {out / "vocals.wav"}  ({voc.stat().st_size / 1024 / 1024:.1f} MB)')
    else:
        print('  没找到人声输出')
        for f in tmp.iterdir():
            print('   ', f.name)

    if inst:
        shutil.copy2(inst, out / 'inst.wav')
        print(f'  伴奏: {out / "inst.wav"}  ({inst.stat().st_size / 1024 / 1024:.1f} MB)')

    # 补齐过的要裁回原长（人声和伴奏都要）
    if padded is not None and raw_dur > 0:
        for name in ('vocals.wav', 'inst.wav'):
            p = out / name
            if not p.exists():
                continue
            trimmed = out / f'_{name}'
            subprocess.run(
                ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
                 '-i', str(p), '-t', f'{raw_dur:.3f}', str(trimmed)],
                check=True,
            )
            shutil.move(str(trimmed), str(p))
        print(f'  已裁回原长 {raw_dur:.1f}s', flush=True)

    return 0 if voc else 1


if __name__ == '__main__':
    sys.exit(main())

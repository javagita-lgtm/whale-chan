"""测试不同 pitch_shift 对高音段的效果。

假设：原唱高音段（460Hz）超出 soyo 舒适音域，模型崩坏。
      如果把整首歌降低到她的音域（pitch_shift 负值），
      模型应该能正常工作。

代价：降低后就不是原调了（翻唱降 key 是常见做法）。
"""

import subprocess
import sys
from pathlib import Path

import numpy as np
import librosa

H = Path(r'E:\SoulX-Singer\hikarigage')
GSV = Path(r'E:\SoulX-Singer\SoulX-Singer-main')
PY = r'E:\svc-venv\Scripts\python.exe'

# 用最崩的 180-210s 段做实验
SEG_START = 180
SEG_LEN = 30

SR = 24000
HOP = 480
FPS = SR // HOP


def prepare_segment() -> tuple[Path, Path]:
    """切出测试段 + 提取 F0。"""
    src = H / 'sep' / 'vocals24k.wav'
    wav = H / 'test-seg' / 'seg.wav'
    wav.parent.mkdir(parents=True, exist_ok=True)

    subprocess.run(
        ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
         '-i', str(src), '-ss', str(SEG_START), '-t', str(SEG_LEN),
         '-ar', str(SR), '-ac', '1', str(wav)],
        check=True,
    )

    f0 = H / 'test-seg' / 'seg_f0.npy'
    if not f0.exists():
        subprocess.run(
            [PY, r'E:\PRO\etc\daliy\whale-chan\scripts\extract_f0.py', str(wav), str(f0)],
            check=True,
        )
    return wav, f0


def run_svc(pitch_shift: int, out_dir: Path, wav: Path, f0: Path) -> Path | None:
    out_dir.mkdir(parents=True, exist_ok=True)
    cmd = [
        PY, '-m', 'cli.inference_svc',
        '--device', 'cuda',
        '--model_path', r'E:\SoulX-Singer\pretrained_models\SoulX-Singer\model-svc.pt',
        '--config', 'soulxsinger/config/soulxsinger.yaml',
        '--prompt_wav_path', r'E:\SoulX-Singer\refs\soyo2.wav',
        '--target_wav_path', str(wav),
        '--prompt_f0_path', r'E:\SoulX-Singer\hikarigage\f0\soyo2_f0.npy',
        '--target_f0_path', str(f0),
        '--save_dir', str(out_dir),
        '--pitch_shift', str(pitch_shift),
        '--fp16',
    ]
    r = subprocess.run(cmd, cwd=str(GSV), capture_output=True, text=True,
                       encoding='utf-8', errors='replace')
    if r.returncode != 0:
        print(f'    SVC 失败: {r.stderr[-300:]}')
        return None
    gen = out_dir / 'generated.wav'
    return gen if gen.exists() else None


def corr_with_orig(gen: Path, orig: Path) -> tuple[float, float]:
    def f0_of(p: Path):
        y, _ = librosa.load(str(p), sr=SR, mono=True)
        f, _, _ = librosa.pyin(
            y,
            fmin=float(librosa.note_to_hz('C2')),
            fmax=float(librosa.note_to_hz('C7')),
            sr=SR, hop_length=HOP,
        )
        return f

    a, b = f0_of(orig), f0_of(gen)
    n = min(len(a), len(b))
    a, b = a[:n], b[:n]
    m = ~np.isnan(a) & ~np.isnan(b)
    if m.sum() < 100:
        return float('nan'), float('nan')

    av = 12 * np.log2(a[m] / np.median(a[m]))
    bv = 12 * np.log2(b[m] / np.median(b[m]))
    c = float(np.corrcoef(av, bv)[0, 1])
    d = float(np.median(12 * np.log2(b[m] / a[m])))
    return c, d


def main() -> None:
    print('准备测试段（180-210s，最崩坏的那段）...')
    wav, f0 = prepare_segment()

    # 原唱该段的 F0
    y, _ = librosa.load(str(wav), sr=SR, mono=True)
    f, _, _ = librosa.pyin(y, fmin=float(librosa.note_to_hz('C2')),
                           fmax=float(librosa.note_to_hz('C7')),
                           sr=SR, hop_length=HOP)
    print(f'  原唱该段 F0 中位数: {np.nanmedian(f):.0f} Hz\n')

    print(f'{"pitch_shift":>12} {"相关性":>8} {"实际音高差":>10} {"说明":>10}')
    print('-' * 46)

    for shift in [-8, -5, -3, 0]:
        out = H / f'test-seg/out-{shift}'
        gen = run_svc(shift, out, wav, f0)
        if gen is None:
            print(f'{shift:>+12} {"失败":>8}')
            continue
        c, d = corr_with_orig(gen, wav)
        tag = '好' if c > 0.85 else ('中' if c > 0.6 else '差')
        print(f'{shift:>+12} {c:>8.3f} {d:>+9.2f} {tag:>10}')


if __name__ == '__main__':
    main()

"""对比不同参考音频对"自然度"的影响。

假设：机械感来自参考音频本身的表现力（说话 vs 唱歌）。
      说话录音缺乏歌唱的气息起伏，克隆出来就"平"。

测试：用同一段原唱，换不同参考音频，对比输出特征。
"""

import subprocess
import sys
from pathlib import Path

import numpy as np
import librosa

H = Path(r'E:\SoulX-Singer\hikarigage')
GSV = Path(r'E:\SoulX-Singer\SoulX-Singer-main')
PY = r'E:\svc-venv\Scripts\python.exe'

SR = 24000
HOP = 480
SEG_START, SEG_LEN = 30, 15

REFS = [
    {'label': 'soyo2', 'wav': r'E:\SoulX-Singer\refs\soyo2.wav',
     'f0': r'E:\SoulX-Singer\hikarigage\f0\soyo2_f0.npy'},
    {'label': 'anon', 'wav': r'E:\GPT-SoVITS\ref\mygo\anon.wav',
     'f0': r'E:\SoulX-Singer\f0\anon_f0.npy'},
    {'label': 'tomori', 'wav': r'E:\GPT-SoVITS\ref\mygo\tomori.wav',
     'f0': None},
]


def prepare_seg() -> tuple[Path, Path]:
    wav = H / 'ref-test' / 'seg.wav'
    f0 = H / 'ref-test' / 'seg_f0.npy'
    wav.parent.mkdir(parents=True, exist_ok=True)
    if not wav.exists():
        subprocess.run(
            ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
             '-i', str(H / 'sep' / 'vocals24k.wav'),
             '-ss', str(SEG_START), '-t', str(SEG_LEN),
             '-ar', str(SR), '-ac', '1', str(wav)],
            check=True,
        )
    if not f0.exists():
        subprocess.run([PY, r'E:\PRO\etc\daliy\whale-chan\scripts\extract_f0.py',
                        str(wav), str(f0)], check=True)
    return wav, f0


def ensure_f0(ref: dict) -> str | None:
    if ref['f0'] and Path(ref['f0']).exists():
        return ref['f0']
    out = H / 'ref-test' / f"{ref['label']}_f0.npy"
    out.parent.mkdir(parents=True, exist_ok=True)
    r = subprocess.run([PY, r'E:\PRO\etc\daliy\whale-chan\scripts\extract_f0.py',
                        ref['wav'], str(out)],
                       capture_output=True, text=True, encoding='utf-8', errors='replace')
    return str(out) if out.exists() else None


def run(ref: dict, ref_f0: str, wav: Path, f0: Path) -> Path | None:
    out = H / 'ref-test' / ref['label']
    out.mkdir(parents=True, exist_ok=True)
    cmd = [
        PY, '-m', 'cli.inference_svc',
        '--device', 'cuda',
        '--model_path', r'E:\SoulX-Singer\pretrained_models\SoulX-Singer\model-svc.pt',
        '--config', 'soulxsinger/config/soulxsinger.yaml',
        '--prompt_wav_path', ref['wav'],
        '--target_wav_path', str(wav),
        '--prompt_f0_path', ref_f0,
        '--target_f0_path', str(f0),
        '--save_dir', str(out),
        '--pitch_shift', '-2',
        '--fp16',
    ]
    r = subprocess.run(cmd, cwd=str(GSV), capture_output=True, text=True,
                       encoding='utf-8', errors='replace')
    p = out / 'generated.wav'
    return p if p.exists() else None


def expr_metrics(p: Path) -> dict:
    """表现力指标：越小越"平"（机械）。"""
    y, _ = librosa.load(str(p), sr=SR, mono=True)

    f, _, _ = librosa.pyin(y, fmin=float(librosa.note_to_hz('C2')),
                           fmax=float(librosa.note_to_hz('C7')),
                           sr=SR, hop_length=HOP)
    v = f[~np.isnan(f)]
    # 颤音强度：F0 曲线的细节起伏
    vib = float(np.std(np.diff(12 * np.log2(v / np.median(v))))) if len(v) > 10 else 0

    # 能量起伏（）歌唱表情
    rms = librosa.feature.rms(y=y, hop_length=HOP)[0]
    rms = rms[rms > 1e-6]
    energy_std = float(np.std(rms) / (np.mean(rms) + 1e-9)) if len(rms) > 2 else 0

    return {'vibrato': vib, 'energy_std': energy_std}


def main() -> None:
    print('准备测试段（30-45s）...')
    wav, f0 = prepare_seg()
    print(f'  {SEG_LEN}s\n')

    # 原唱基准
    base = expr_metrics(H / 'ref-test' / 'seg.wav')
    print(f'原唱基准:  颤音 {base["vibrato"]:.3f}  能量起伏 {base["energy_std"]:.3f}\n')

    print(f'{"参考":<10}{"颤音":>8}{"能量起伏":>10}{"vs原唱颤音":>12}')
    print('-' * 42)

    for ref in REFS:
        rf0 = ensure_f0(ref)
        if not rf0:
            print(f'{ref["label"]:<10}{"F0失败":>8}')
            continue
        p = run(ref, rf0, wav, f0)
        if not p:
            print(f'{ref["label"]:<10}{"推理失败":>8}')
            continue
        m = expr_metrics(p)
        ratio = m['vibrato'] / base['vibrato'] if base['vibrato'] > 0 else 0
        print(f'{ref["label"]:<10}{m["vibrato"]:>8.3f}{m["energy_std"]:>10.3f}{ratio:>11.2f}x')


if __name__ == '__main__':
    main()

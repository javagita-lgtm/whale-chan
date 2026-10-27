"""测试 SVC 参数对音质（机械感）的影响。

可调参数：
  n_steps : 扩散步数，默认 32。越高越细腻（也越慢）
  cfg     : classifier-free guidance，默认 3.0。越高越贴参考音色，
            过高会发尖/发紧（机械感）

机械感的量化指标：
  - 谱平坦度（spectral flatness）：越高越像噪声，机械感越强
  - F0 抖动（相邻帧 F0 突变率）：越高越抖
  - 能量突变率：越高越"切块"
"""

import json
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

# 用一个好段（30-60s，相关性 0.98）做实验
SEG_START = 30
SEG_LEN = 20

CONFIGS = [
    {'n_steps': 32, 'cfg': 3.0, 'label': 'baseline'},
    {'n_steps': 64, 'cfg': 3.0, 'label': 'steps64'},
    {'n_steps': 100, 'cfg': 3.0, 'label': 'steps100'},
    {'n_steps': 64, 'cfg': 2.0, 'label': 'steps64_cfg2'},
    {'n_steps': 64, 'cfg': 4.0, 'label': 'steps64_cfg4'},
]


def prepare() -> tuple[Path, Path]:
    wav = H / 'param-test' / 'seg.wav'
    f0 = H / 'param-test' / 'seg_f0.npy'
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
        subprocess.run(
            [PY, r'E:\PRO\etc\daliy\whale-chan\scripts\extract_f0.py', str(wav), str(f0)],
            check=True,
        )
    return wav, f0


def run(cfg_d: dict, wav: Path, f0: Path) -> Path | None:
    out = H / 'param-test' / cfg_d['label']
    out.mkdir(parents=True, exist_ok=True)
    cmd = [
        PY, '-m', 'cli.inference_svc',
        '--device', 'cuda',
        '--model_path', r'E:\SoulX-Singer\pretrained_models\SoulX-Singer\model-svc.pt',
        '--config', 'soulxsinger/config/soulxsinger.yaml',
        '--prompt_wav_path', r'E:\SoulX-Singer\refs\soyo2.wav',
        '--target_wav_path', str(wav),
        '--prompt_f0_path', r'E:\SoulX-Singer\hikarigage\f0\soyo2_f0.npy',
        '--target_f0_path', str(f0),
        '--save_dir', str(out),
        '--pitch_shift', '-2',
        '--n_steps', str(cfg_d['n_steps']),
        '--cfg', str(cfg_d['cfg']),
        '--fp16',
    ]
    r = subprocess.run(cmd, cwd=str(GSV), capture_output=True, text=True,
                       encoding='utf-8', errors='replace')
    if r.returncode != 0:
        print(f'  {cfg_d["label"]}: 失败 {r.stderr[-200:]}')
        return None
    p = out / 'generated.wav'
    return p if p.exists() else None


def metrics(p: Path) -> dict:
    y, _ = librosa.load(str(p), sr=SR, mono=True)

    flat = float(np.mean(librosa.feature.spectral_flatness(y=y)))

    # F0 抖动：相邻有声帧的半音差绝对值均值
    f, _, _ = librosa.pyin(
        y,
        fmin=float(librosa.note_to_hz('C2')),
        fmax=float(librosa.note_to_hz('C7')),
        sr=SR,
        hop_length=HOP,
    )
    v = f[~np.isnan(f)]
    jitter = float(np.mean(np.abs(np.diff(12 * np.log2(v / np.median(v)))))) if len(v) > 2 else 0

    # 能量突变：相邻帧 RMS 的相对跳变
    rms = librosa.feature.rms(y=y, hop_length=HOP)[0]
    rms = rms[rms > 1e-6]
    jumps = float(np.mean(np.abs(np.diff(rms)) / (np.mean(rms) + 1e-9))) if len(rms) > 2 else 0

    return {
        'flat': flat,
        'jitter': jitter,
        'energy_jump': jumps,
        'dur': len(y) / SR,
    }


def main() -> None:
    print('准备测试段（30-60s，原唱相关性 0.98 的好段）...')
    wav, f0 = prepare()
    print(f'  {SEG_LEN}s\n')

    results = []
    print(f'{"配置":<16}{"谱平坦":>10}{"F0抖动":>10}{"能量突变":>10}{"耗时":>8}')
    print('-' * 56)

    import time
    for c in CONFIGS:
        t0 = time.time()
        p = run(c, wav, f0)
        el = time.time() - t0
        if p is None:
            continue
        m = metrics(p)
        m['label'] = c['label']
        m['n_steps'] = c['n_steps']
        m['cfg'] = c['cfg']
        m['elapsed'] = round(el, 1)
        results.append(m)
        print(f'{c["label"]:<16}{m["flat"]:>10.4f}{m["jitter"]:>10.3f}'
              f'{m["energy_jump"]:>10.3f}{el:>7.0f}s')

    if results:
        # 综合"自然度"评分：谱平坦低 + 抖动低 + 能量突变低
        print('\n自然度评分（越高越好）:')
        base = results[0]
        for r in results:
            score = (
                (base['flat'] / (r['flat'] + 1e-9)) * 0.4
                + (base['jitter'] / (r['jitter'] + 1e-9)) * 0.3
                + (base['energy_jump'] / (r['energy_jump'] + 1e-9)) * 0.3
            )
            r['score'] = round(score, 3)
            print(f'  {r["label"]:<16}{score:>7.3f}')

        best = max(results, key=lambda x: x['score'])
        print(f'\n最佳配置: {best["label"]} (n_steps={best["n_steps"]}, cfg={best["cfg"]})')

        out = H / 'param-test' / 'results.json'
        out.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
        print(f'已写入 {out}')


if __name__ == '__main__':
    main()

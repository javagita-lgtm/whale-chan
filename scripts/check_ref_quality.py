"""检查所有音色参考音频的质量。

2026-10-27 踩的坑：
  soyo.wav 用来做 TTS 参考时，短文本合成出来只有 0.38 秒（被截断）。
  原因：参考音频里有效语音太少（只有 1.5 秒左右的短促台词）。
  换成有 5 秒连续语音的参考后就正常了。

所以参考音频的「有效语音占比」是个硬指标。
"""

from pathlib import Path

import numpy as np
import librosa

DIRS = [
    Path(r'E:\GPT-SoVITS\ref\mygo'),
    Path(r'E:\SoulX-Singer\refs'),
]

SR = 24000
HOP = 480


def analyze(p: Path) -> dict:
    y, _ = librosa.load(str(p), sr=SR, mono=True)
    f0, _, _ = librosa.pyin(
        y,
        fmin=float(librosa.note_to_hz('C2')),
        fmax=float(librosa.note_to_hz('C7')),
        sr=SR,
        hop_length=HOP,
    )
    v = f0[~np.isnan(f0)]
    return {
        'dur': len(y) / SR,
        'ratio': len(v) / len(f0) if len(f0) else 0.0,
        'f0': float(np.median(v)) if len(v) else 0.0,
        # 连续有声段最长多少秒（比总占比更能反映"够不够念一句"）
        'longest': _longest_run(f0) * HOP / SR,
    }


def _longest_run(f0: np.ndarray) -> int:
    best = cur = 0
    for x in f0:
        if np.isnan(x):
            cur = 0
        else:
            cur += 1
            best = max(best, cur)
    return best


print(f'{"音色":<12}{"时长":>7}{"有声比":>8}{"最长连续":>9}{"F0":>7}  判定')
print('-' * 58)

for d in DIRS:
    if not d.exists():
        continue
    for f in sorted(d.glob('*.wav')):
        r = analyze(f)
        # 判据：最长连续有声 >= 2.5 秒才算合格
        ok = r['longest'] >= 2.5 and r['ratio'] >= 0.5
        print(
            f'{f.stem:<12}{r["dur"]:>7.2f}{r["ratio"]:>8.1%}'
            f'{r["longest"]:>8.2f}s{r["f0"]:>7.0f}  {"OK" if ok else "太短 ⚠️"}',
        )

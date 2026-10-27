"""定位 SVC 翻唱里崩坏的段落，并诊断原因。

已知（2026-10-27 实测）：
  春日影 4分17秒，soyo 音色翻唱后分段相关性差异极大
    0-60s    0.98  几乎完美
    60-90s   0.49  明显劣化
    180-210s -0.08  完全崩坏

诊断方向：
  1. 崩坏段落原唱是否有特殊特征（和声/高音/气声/念白）
  2. 翻唱段落是否出现异常（静音、削波、单音重复）
"""

import sys
from pathlib import Path

import numpy as np
import librosa

ORIG = Path(r'E:\SoulX-Singer\hikarigage\sep\vocals24k.wav')
COVER = Path(r'E:\SoulX-Singer\hikarigage\out2\generated.wav')
SR = 24000
HOP = 480
FPS = SR // HOP


def load(p: Path):
    y, _ = librosa.load(str(p), sr=SR, mono=True)
    f, _, _ = librosa.pyin(
        y,
        fmin=float(librosa.note_to_hz('C2')),
        fmax=float(librosa.note_to_hz('C7')),
        sr=SR,
        hop_length=HOP,
    )
    return y, f


print('加载 ...')
yo, fo = load(ORIG)
yc, fc = load(COVER)
n = min(len(fo), len(fc))

print(f'\n{"时段":>12} {"相关":>7} {"原唱有声":>9} {"翻唱有声":>9} '
      f'{"原唱F0":>9} {"翻唱F0":>9} {"翻唱/原唱能量":>13}')
print('-' * 82)

seg = 30 * FPS
for s in range(0, n, seg):
    e = min(s + seg, n)
    x, y = fo[s:e], fc[s:e]
    m = ~np.isnan(x) & ~np.isnan(y)

    if m.sum() < 100:
        corr = float('nan')
    else:
        xv = 12 * np.log2(x[m] / np.median(x[m]))
        yv = 12 * np.log2(y[m] / np.median(y[m]))
        corr = float(np.corrcoef(xv, yv)[0, 1])

    o_voiced = np.mean(~np.isnan(x))
    c_voiced = np.mean(~np.isnan(y))
    o_f0 = np.nanmedian(x) if np.any(~np.isnan(x)) else 0
    c_f0 = np.nanmedian(y) if np.any(~np.isnan(y)) else 0

    # 能量比（对应时间段的 RMS）
    so, sc = s * HOP, e * HOP
    eo = np.sqrt(np.mean(yo[so:sc] ** 2)) if so < len(yo) else 0
    ec = np.sqrt(np.mean(yc[so:sc] ** 2)) if so < len(yc) else 0
    ratio = ec / eo if eo > 1e-6 else 0

    print(f'{s // FPS:>5}-{e // FPS:<6}s {corr:>7.2f} {o_voiced:>8.0%} {c_voiced:>8.0%} '
          f'{o_f0:>9.0f} {c_f0:>9.0f} {ratio:>13.2f}')

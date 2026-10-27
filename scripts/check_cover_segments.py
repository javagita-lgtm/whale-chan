"""分段检查 SVC 翻唱与原唱的旋律相关性。

目的：判断相关性低是全程均匀劣化，还是某些段落崩掉。
"""

import sys
from pathlib import Path

import numpy as np
import librosa

ORIG = Path(r'E:\SoulX-Singer\hikarigage\sep\vocals24k.wav')
COVER = Path(r'E:\SoulX-Singer\hikarigage\out2\generated.wav')
SR = 24000
HOP = 480
FPS = SR // HOP  # 50


def f0(p: Path) -> np.ndarray:
    y, _ = librosa.load(str(p), sr=SR, mono=True)
    f, _, _ = librosa.pyin(
        y,
        fmin=float(librosa.note_to_hz('C2')),
        fmax=float(librosa.note_to_hz('C7')),
        sr=SR,
        hop_length=HOP,
    )
    return f


print('提取 F0 ...')
a = f0(ORIG)
b = f0(COVER)
n = min(len(a), len(b))
print(f'  {n} 帧 = {n / FPS:.1f}s\n')

seg = 30 * FPS  # 30 秒
print(f'{"时间段":>14} {"有声帧":>8} {"相关性":>8} {"音高差中位":>10}')
print('-' * 46)

vals = []
for s in range(0, n, seg):
    e = min(s + seg, n)
    x, y = a[s:e], b[s:e]
    m = ~np.isnan(x) & ~np.isnan(y)
    if m.sum() < 100:
        continue
    xv = 12 * np.log2(x[m] / np.median(x[m]))
    yv = 12 * np.log2(y[m] / np.median(y[m]))
    c = float(np.corrcoef(xv, yv)[0, 1])
    d = float(np.median(12 * np.log2(y[m] / x[m])))
    vals.append(c)
    print(f'{s // FPS:>5}-{e // FPS:<7}s {m.sum():>8} {c:>8.3f} {d:>+9.2f}')

if vals:
    print(f'\n  平均 {np.mean(vals):.3f}  最好 {max(vals):.3f}  最差 {min(vals):.3f}')

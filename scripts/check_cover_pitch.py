"""对比原唱和 SVC 翻唱的音高轮廓，验证是否走调。

如果不走调：两者的 F0 曲线应该高度相关（同样旋律）
但数值不同（不同音色/音域）。
"""

import sys
from pathlib import Path

import numpy as np
import librosa

ORIG = Path(r'E:\SoulX-Singer\hikarigage\sep\vocals24k.wav')
COVER = Path(r'E:\SoulX-Singer\hikarigage\out\generated.wav')


def f0_of(p: Path) -> np.ndarray:
    y, sr = librosa.load(str(p), sr=24000, mono=True)
    f0, _, _ = librosa.pyin(
        y,
        fmin=float(librosa.note_to_hz('C2')),
        fmax=float(librosa.note_to_hz('C7')),
        sr=sr,
        hop_length=480,
    )
    return f0


print('提取 F0 ...')
a = f0_of(ORIG)
b = f0_of(COVER)

n = min(len(a), len(b))
a, b = a[:n], b[:n]

# 只比较双方都有声（非 nan）的帧
mask = ~np.isnan(a) & ~np.isnan(b)
print(f'  总帧数 {n}，双方都有声 {mask.sum()} 帧 ({mask.sum() / n:.1%})')

if mask.sum() < 100:
    print('  有声帧太少，无法比较')
    sys.exit(1)

av, bv = a[mask], b[mask]

# 半音差
diff = 12 * np.log2(bv / av)
print(f'\n  音高差（SVC - 原唱）:')
print(f'    中位数 {np.median(diff):+.2f} 半音')
print(f'    均值   {np.mean(diff):+.2f} 半音')
print(f'    标准差 {np.std(diff):.2f} 半音')
print(f'    68% 落在 {np.percentile(diff, 16):+.2f} ~ {np.percentile(diff, 84):+.2f}')

# 相关系数：旋律是否一致（都除去均值）
a0 = 12 * np.log2(av / np.mean(av))
b0 = 12 * np.log2(bv / np.mean(bv))
corr = float(np.corrcoef(a0, b0)[0, 1])
print(f'\n  旋律相关性: {corr:.4f}')

print('\n  判定:')
if corr > 0.9:
    print('    ✅ 旋律高度一致，没有走调')
elif corr > 0.7:
    print('    ⚠️ 旋律基本一致，但有些偏差')
else:
    print('    ❌ 旋律对不上，可能有问题')

if abs(np.median(diff)) < 1:
    print('    ✅ 音高基本一致（未变调）')
else:
    print(f'    音高偏移 {np.median(diff):+.1f} 半音（auto_shift 的结果）')

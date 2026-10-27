"""检查 SVC 翻唱是否存在时间偏移。

上一版直接逐帧比较得到相关性 0.67，偏低。
但 SVC 分段重叠相加可能引入几十毫秒的偏移，
表现为"旋律对不上"其实是"时间错开了"。这里做互相关验证。
"""

import sys
from pathlib import Path

import numpy as np
import librosa

ORIG = Path(r'E:\SoulX-Singer\hikarigage\sep\vocals24k.wav')
COVER = Path(r'E:\SoulX-Singer\hikarigage\out2\generated.wav')

HOP = 480
SR = 24000


def f0_of(p: Path) -> np.ndarray:
    y, _ = librosa.load(str(p), sr=SR, mono=True)
    f0, _, _ = librosa.pyin(
        y,
        fmin=float(librosa.note_to_hz('C2')),
        fmax=float(librosa.note_to_hz('C7')),
        sr=SR,
        hop_length=HOP,
    )
    return f0


def report(a: np.ndarray, b: np.ndarray, label: str) -> None:
    n = min(len(a), len(b))
    a, b = a[:n], b[:n]
    mask = ~np.isnan(a) & ~np.isnan(b)
    if mask.sum() < 100:
        print(f'  {label}: 有声帧太少')
        return

    av = 12 * np.log2(a[mask] / np.median(a[mask]))
    bv = 12 * np.log2(b[mask] / np.median(b[mask]))
    corr = float(np.corrcoef(av, bv)[0, 1])
    print(f'  {label}: 相关 {corr:.4f}  (帧偏移 {label})')


print('提取 F0 ...')
a = f0_of(ORIG)
b = f0_of(COVER)
print(f'  原唱 {len(a)} 帧, 翻唱 {len(b)} 帧\n')

# 用半音化 + 填 nan 的曲线做互相关，找最佳时间偏移
n = min(len(a), len(b))
aa = 12 * np.log2(a[:n] / np.nanmedian(a[:n]))
bb = 12 * np.log2(b[:n] / np.nanmedian(b[:n]))

# nan 用 0 填（等价于"无声"），先各自减均值
am = np.nan_to_num(aa - np.nanmean(aa), nan=0.0)
bm = np.nan_to_num(bb - np.nanmean(bb), nan=0.0)

# 只在有声音的地方算，避免静音占主导
voiced = ~np.isnan(a[:n]) | ~np.isnan(b[:n])
am = am * voiced
bm = bm * voiced

# 互相关（用 FFT 加速，限制 lag 范围 ±2 秒 = ±100 帧）
max_lag = 100
best_lag, best_corr = 0, -2.0
for lag in range(-max_lag, max_lag + 1):
    if lag >= 0:
        x, y = am[: n - lag], bm[lag:]
    else:
        x, y = am[-lag:], bm[: n + lag]
    if len(x) < 500:
        continue
    c = float(np.corrcoef(x, y)[0, 1])
    if c > best_corr:
        best_corr, best_lag = c, lag

print(f'最佳时间偏移: {best_lag} 帧 = {best_lag * HOP / SR * 1000:.0f} ms')
print(f'该偏移下的相关性: {best_corr:.4f}\n')

# 按最佳偏移重新对齐后比较
if best_lag >= 0:
    a2, b2 = a[: n - best_lag], b[best_lag:]
else:
    a2, b2 = a[-best_lag:], b[: n + best_lag]

mask = ~np.isnan(a2) & ~np.isnan(b2)
if mask.sum() > 100:
    av = a2[mask]
    bv = b2[mask]
    diff = 12 * np.log2(bv / av)
    a0 = 12 * np.log2(av / np.median(av))
    b0 = 12 * np.log2(bv / np.median(bv))
    corr = float(np.corrcoef(a0, b0)[0, 1])

    print('对齐后:')
    print(f'  音高差中位数 {np.median(diff):+.2f} 半音')
    print(f'  标准差       {np.std(diff):.2f} 半音')
    print(f'  旋律相关性   {corr:.4f}')
    print()
    if corr > 0.9:
        print('  [OK] 旋律高度一致，没有走调')
    elif corr > 0.75:
        print('  [WARN] 旋律基本一致，有轻微偏差')
    else:
        print('  [FAIL] 旋律明显对不上')

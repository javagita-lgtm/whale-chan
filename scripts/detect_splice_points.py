"""检测 SVC 输出里的段落拼接点（硬接导致的不连续）。

原理：
  如果段与段之间是硬接的，那么在拼接点前后几毫秒内，
  音频的能量和相位会出现突变。

检测方法：
  1. 算短时能量的相邻帧差
  2. 找突变峰值
  3. 与预期的段落边界（30 秒整数倍附近）对照
"""

from pathlib import Path

import numpy as np
import librosa

COVER = Path(r'E:\SoulX-Singer\hikarigage\out2\generated.wav')
SR = 24000
HOP = 64  # 细粒度：2.7ms 一帧，能定位到毫秒

print('加载 ...')
y, _ = librosa.load(str(COVER), sr=SR, mono=True)
print(f'  {len(y) / SR:.1f}s\n')

# 短时能量 + 一阶差分
rms = librosa.feature.rms(y=y, hop_length=HOP)[0]
d = np.abs(np.diff(rms))

# 找突变（超过中位数 20 倍）
med = np.median(d) + 1e-9
peaks = np.where(d > med * 20)[0]
times = peaks * HOP / SR

print(f'能量突变点: {len(times)} 个（阈值 {med*20:.5f}）')
print(f'突变强度中位数: {np.median(d[peaks]):.5f}\n')

# 只看强度最大的 20 个
order = np.argsort(-d[peaks])[:20]
top = sorted(times[order])

print(f'{"时间":>10}{"到30s边界":>12}{"能量跃变":>12}')
print('-' * 36)
for t in top:
    idx = int(t * SR / HOP)
    jump = d[idx] if idx < len(d) else 0
    # 最近的 30 秒整数倍
    near = round(t / 30) * 30
    delta = t - near
    mark = ' <-- 段边界' if abs(delta) < 0.5 else ''
    print(f'{t:>9.2f}s{delta:>+11.2f}s{jump:>12.5f}{mark}')

# 统计：30 秒边界附近 ±0.5s 有多少突变
near_boundary = sum(1 for t in top if abs(t - round(t / 30) * 30) < 0.5)
print(f'\nTop20 中落在 30s 边界 ±0.5s 内的: {near_boundary} 个')
if near_boundary >= 3:
    print('  => 确认：段边界处存在能量不连续（硬接）')
else:
    print('  => 边界处没有明显不连续，机械感另有原因')

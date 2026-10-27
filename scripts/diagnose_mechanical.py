"""诊断机械感来源：对比原唱 vs 翻唱的频谱细节。

机械感的常见成因（可测量）：
  1. 高频缺失（谱滚降点偏低）→ 发闷、发干
  2. 谱对比度低（谐波不清晰）→ 电子味
  3. 节律规整（自相关过强）→ 机械重复感
  4. 动态范围压缩（响度过于均匀）→ 不自然
"""

from pathlib import Path

import numpy as np
import librosa

ORIG = Path(r'E:\SoulX-Singer\hikarigage\sep\vocals24k.wav')
COVER = Path(r'E:\SoulX-Singer\hikarigage\out2\generated.wav')

SR = 24000
START, DUR = 30, 20  # 用 30-50s 的好段落，避开崩坏段


def analyze(p: Path, label: str) -> dict:
    y, _ = librosa.load(str(p), sr=SR, mono=True, offset=START, duration=DUR)

    # 1. 谱滚降（高频保留程度）：85% 能量对应的频率
    rolloff = float(np.mean(librosa.feature.spectral_rolloff(y=y, sr=SR, roll_percent=0.85)))

    # 2. 谱对比度（谐波清晰度）
    contrast = librosa.feature.spectral_contrast(y=y, sr=SR)
    contrast_mean = float(np.mean(contrast))

    # 3. 谱平坦度（噪声感）
    flat = float(np.mean(librosa.feature.spectral_flatness(y=y)))

    # 4. 动态范围：RMS 的 P95/P5 比（dB）
    rms = librosa.feature.rms(y=y, hop_length=256)[0]
    rms = rms[rms > 1e-6]
    dyn = float(20 * np.log10(np.percentile(rms, 95) / (np.percentile(rms, 5) + 1e-9)))

    # 5. 节律规整度：包络自相关的峰值
    env = librosa.onset.onset_strength(y=y, sr=SR)
    if len(env) > 100:
        ac = np.correlate(env - env.mean(), env - env.mean(), mode='full')[len(env) - 1:]
        ac = ac / (ac[0] + 1e-9)
        # 看 100~500ms 范围内（相当于 2~10 Hz 节律）的最大自相关
        lo, hi = int(0.1 * SR / 512), int(0.5 * SR / 512)
        rhythm = float(np.max(ac[lo:hi])) if hi < len(ac) else 0
    else:
        rhythm = 0

    # 6. 高频能量占比（>6kHz）
    S = np.abs(librosa.stft(y, n_fft=2048))
    freqs = librosa.fft_frequencies(sr=SR, n_fft=2048)
    hi_mask = freqs > 6000
    hf_ratio = float(np.sum(S[hi_mask] ** 2) / (np.sum(S ** 2) + 1e-9))

    print(f'\n=== {label} ===')
    print(f'  谱滚降(85%)   {rolloff:>9.0f} Hz')
    print(f'  谱对比度      {contrast_mean:>9.2f}')
    print(f'  谱平坦度      {flat:>9.5f}')
    print(f'  动态范围      {dyn:>9.1f} dB')
    print(f'  节律规整度    {rhythm:>9.3f}')
    print(f'  高频占比      {hf_ratio:>9.4f}')

    return {
        'rolloff': rolloff, 'contrast': contrast_mean, 'flat': flat,
        'dyn': dyn, 'rhythm': rhythm, 'hf': hf_ratio,
    }


print(f'分析 30-50s 段落（翻唱该段相关性 0.98，属于好段）')
a = analyze(ORIG, '原唱')
b = analyze(COVER, 'SVC 翻唱')

print('\n=== 差异（翻唱 / 原唱）===')
for k, name, unit in [
    ('rolloff', '谱滚降', 'Hz'),
    ('contrast', '谱对比度', ''),
    ('flat', '谱平坦度', ''),
    ('dyn', '动态范围', 'dB'),
    ('rhythm', '节律规整度', ''),
    ('hf', '高频占比', ''),
]:
    if a[k] > 1e-9:
        ratio = b[k] / a[k]
        flag = ''
        if k == 'rolloff' and ratio < 0.8:
            flag = ' <-- 高频缺失'
        if k == 'contrast' and ratio < 0.8:
            flag = ' <-- 谐波不清晰'
        if k == 'flat' and ratio > 1.5:
            flag = ' <-- 噪声感增强'
        if k == 'dyn' and ratio < 0.7:
            flag = ' <-- 动态被压'
        if k == 'rhythm' and ratio > 1.3:
            flag = ' <-- 节律过于规整'
        print(f'  {name:<12}{b[k]:>10.3f} / {a[k]:>10.3f} = {ratio:>6.2f}x{flag}')

"""对比「好段落」和「崩坏段落」的声学特征，找根因。"""

from pathlib import Path

import numpy as np
import librosa

SRC = Path(r'E:\SoulX-Singer\hikarigage\sep\vocals24k.wav')
SR = 24000
HOP = 480

SEGMENTS = [
    ('好 0-30s', 0, 30),
    ('好 90-120s', 90, 120),
    ('崩 150-180s', 150, 180),
    ('崩 180-210s', 180, 210),
]


def feat(y: np.ndarray, s: float, e: float) -> dict:
    seg = y[int(s * SR):int(e * SR)]
    if len(seg) == 0:
        return {}

    f, _, _ = librosa.pyin(
        seg,
        fmin=float(librosa.note_to_hz('C2')),
        fmax=float(librosa.note_to_hz('C7')),
        sr=SR,
        hop_length=HOP,
    )
    v = f[~np.isnan(f)]

    # 谱特征
    flat = float(np.mean(librosa.feature.spectral_flatness(y=seg)))
    cent = float(np.mean(librosa.feature.spectral_centroid(y=seg, sr=SR)))
    zcr = float(np.mean(librosa.feature.zero_crossing_rate(seg)))

    # 谐波比例（HPSS）
    yh, yp = librosa.effects.hpss(seg)
    harm_ratio = float(np.sum(yh ** 2) / (np.sum(seg ** 2) + 1e-9))

    return {
        'f0': float(np.median(v)) if len(v) else 0,
        'f0_std': float(np.std(v)) if len(v) else 0,
        'flat': flat,
        'cent': cent,
        'zcr': zcr,
        'harm': harm_ratio,
        'voiced': len(v) / len(f) if len(f) else 0,
    }


print('加载音频 ...')
y, _ = librosa.load(str(SRC), sr=SR, mono=True)
print()

hdr = f'{"段落":<14}{"F0":>7}{"F0std":>8}{"谱平坦":>9}{"谱质心":>9}{"过零率":>9}{"谐波比":>9}{"有声比":>8}'
print(hdr)
print('-' * len(hdr))

for label, s, e in SEGMENTS:
    r = feat(y, s, e)
    if not r:
        continue
    print(
        f'{label:<14}{r["f0"]:>7.0f}{r["f0_std"]:>8.1f}{r["flat"]:>9.4f}'
        f'{r["cent"]:>9.0f}{r["zcr"]:>9.4f}{r["harm"]:>9.3f}{r["voiced"]:>8.0%}',
    )

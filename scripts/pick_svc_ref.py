"""为 SVC 挑选合适的音色参考音频。

背景（2026-10-27 实测踩坑）：
  用 mygo/soyo.wav 做参考翻唱春日影，结果旋律相关性只有 0.67（走调）。
  原因：
    - soyo.wav 的 F0 中位数 505 Hz，而原唱只有 330 Hz
    - auto_shift 因此把整首歌上搬 7 个半音，超出合理音域
    - 且该文件 voiced_ratio 仅 0.396（一半以上静音）

挑选标准：
  1. voiced_ratio 高（有声帧占比，越干净越好）
  2. F0 中位数落在合理女声区间（200~450 Hz）
  3. 时长 3~8 秒
  4. 优先情绪平和（不带极端语气，避免音色被带偏）

输出：按综合得分排序的候选清单
"""

import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import librosa

VM = Path(r'E:\PRO\etc\daliy\whale-chan\voicemodel\参考音频')
HOP = 480
SR = 24000


def dur(p: Path) -> float:
    try:
        r = subprocess.run(
            ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
             '-of', 'csv=p=0', str(p)],
            capture_output=True, text=True, timeout=20,
        )
        return float(r.stdout.strip())
    except Exception:  # noqa: BLE001
        return 0.0


def analyze(p: Path) -> dict | None:
    try:
        y, _ = librosa.load(str(p), sr=SR, mono=True)
        f0, _, _ = librosa.pyin(
            y,
            fmin=float(librosa.note_to_hz('C2')),
            fmax=float(librosa.note_to_hz('C7')),
            sr=SR,
            hop_length=HOP,
        )
        v = f0[~np.isnan(f0)]
        if len(v) < 50:
            return None
        return {
            'f0_median': float(np.median(v)),
            'f0_p10': float(np.percentile(v, 10)),
            'f0_p90': float(np.percentile(v, 90)),
            'voiced_ratio': len(v) / len(f0),
            'dur': len(y) / SR,
        }
    except Exception:  # noqa: BLE001
        return None


def main() -> None:
    char = sys.argv[1] if len(sys.argv) > 1 else 'Soyo干声素材'

    d = VM / char
    if not d.exists():
        print(f'目录不存在: {d}')
        sys.exit(1)

    cands = []
    for f in d.rglob('*.wav'):
        # 跳过自动切分的碎片
        if '.WAV_' in f.name.upper():
            continue
        dd = dur(f)
        if not (3.0 <= dd <= 8.0):
            continue
        a = analyze(f)
        if a is None:
            continue
        # 只保留正常女声区间
        if not (200 <= a['f0_median'] <= 450):
            continue
        if a['voiced_ratio'] < 0.6:
            continue

        # 打分：有声比高 + 音高居中 + 时长接近 5 秒
        score = (
            a['voiced_ratio'] * 3.0
            - abs(a['f0_median'] - 320) / 100
            - abs(a['dur'] - 5.0) / 5
        )
        cands.append({
            'path': str(f),
            'name': f.name,
            'score': round(score, 3),
            **{k: round(v, 3) for k, v in a.items()},
        })

    cands.sort(key=lambda x: -x['score'])

    print(f'{char}: {len(cands)} 个合格候选\n')
    print(f'{"得分":>6} {"时长":>6} {"F0中位":>8} {"有声比":>7}  文件')
    print('-' * 90)
    for c in cands[:12]:
        print(
            f'{c["score"]:>6.2f} {c["dur"]:>6.2f} {c["f0_median"]:>8.1f} '
            f'{c["voiced_ratio"]:>7.1%}  {c["name"][:44]}',
        )

    if cands:
        out = Path(r'E:\SoulX-Singer\refs_candidates.json')
        out.write_text(json.dumps(cands, ensure_ascii=False, indent=2), encoding='utf-8')
        print(f'\n已写入 {out}')
        print(f'\n推荐使用: {cands[0]["path"]}')


if __name__ == '__main__':
    main()

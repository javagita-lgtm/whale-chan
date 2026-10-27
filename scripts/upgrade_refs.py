"""把所有角色的参考音频换成「有声比最高」的那一版。

背景（2026-10-27 实测）：
  soyo.wav 的有声比只有 42.6%，用它合成短文本时
  输出经常被截断成 0.38 秒（听起来只有一声"啊"）。
  换成有声比 69.9% 的参考后就稳定正常。

结论：参考音频的「有效语音占比」直接决定 TTS 是否可靠。

这个脚本：
  1. 扫描每个角色的干声素材，挑有声比最高的 3~8 秒片段
  2. 复制到 E:\\GPT-SoVITS\\ref\\mygo\\<char>.wav（覆盖）
  3. 同步更新 mygo-voices.json 里的参考文本和时长
"""

import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import librosa

VM = Path(r'E:\PRO\etc\daliy\whale-chan\voicemodel\参考音频')
MYGO = Path(r'E:\GPT-SoVITS\ref\mygo')
VOICES_JSON = MYGO / 'mygo-voices.json'

SR = 24000
HOP = 480

# 目录名（注意 taki 的素材目录大小写和权重名不同）
CHARS = {
    'anon': 'Anon干声素材',
    'soyo': 'Soyo干声素材',
    'tomori': 'Tomori干声素材',
    'taki': 'Taki干声素材',
    'rana': 'Rana干声素材',
    'sakiko': 'sakiko',
}


def duration(p: Path) -> float:
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
            'f0': float(np.median(v)),
            'ratio': len(v) / len(f0),
            'dur': len(y) / SR,
        }
    except Exception:  # noqa: BLE001
        return None


def best_for(char: str, sub: str) -> tuple[Path, dict] | None:
    d = VM / sub
    if not d.exists():
        print(f'  {char}: 素材目录不存在 {d}')
        return None

    cands = []
    for f in d.rglob('*.wav'):
        if '.WAV_' in f.name.upper():
            continue
        dur = duration(f)
        if not (3.0 <= dur <= 8.0):
            continue
        a = analyze(f)
        if a is None:
            continue
        # 有声比低或多半静音的不要
        if a['ratio'] < 0.6:
            continue
        # 音高要在合理女声区间
        if not (180 <= a['f0'] <= 480):
            continue
        # 打分：有声比为主，时长接近 5 秒加分
        a['score'] = a['ratio'] * 3 - abs(a['dur'] - 5.0) / 5
        cands.append((f, a))

    if not cands:
        return None
    cands.sort(key=lambda x: -x[1]['score'])
    return cands[0]


def main() -> None:
    if not VOICES_JSON.exists():
        print(f'缺少 {VOICES_JSON}')
        sys.exit(1)

    voices = json.loads(VOICES_JSON.read_text(encoding='utf-8'))
    print(f'{"角色":<10}{"有声比":>8}{"时长":>7}{"F0":>7}  来源')
    print('-' * 76)

    changed = 0
    for v in voices:
        vid = v.get('id', '')
        sub = CHARS.get(vid)
        if not sub:
            continue

        old = Path(v.get('refAudio', ''))
        old_ratio = None
        if old.exists():
            oa = analyze(old)
            old_ratio = oa['ratio'] if oa else None

        picked = best_for(vid, sub)
        if not picked:
            print(f'{vid:<10}{"—":>8}{"—":>7}{"—":>7}  无合格候选，保留原样')
            continue

        src, a = picked
        if old_ratio is not None and a['ratio'] <= old_ratio + 0.02:
            print(
                f'{vid:<10}{old_ratio:>8.1%}{"—":>7}{"—":>7}  现有已是最优，跳过',
            )
            continue

        dst = MYGO / f'{vid}.wav'
        shutil.copy2(src, dst)

        # 参考文本 = 文件名去掉扩展名和尾部标点
        text = src.stem.rstrip('。.…、!！?？').strip()
        v['refAudio'] = str(dst)
        v['refText'] = text
        v['refDur'] = round(a['dur'], 2)
        changed += 1

        print(
            f'{vid:<10}{a["ratio"]:>8.1%}{a["dur"]:>7.2f}{a["f0"]:>7.0f}  '
            f'{src.name[:36]}',
        )

    if changed:
        VOICES_JSON.write_text(
            json.dumps(voices, ensure_ascii=False, indent=2), encoding='utf-8',
        )
    print(f'\n更新 {changed} 个音色的参考音频')
    print(f'已写入 {VOICES_JSON}')


if __name__ == '__main__':
    main()

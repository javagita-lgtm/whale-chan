"""把好段落拼接成完整翻唱，带交叉淡化。

为什么需要交叉淡化：
  即使每个片段本身没问题，直接硬接也会在接缝处产生
  能量/相位的突变，听感上就是"咔"一下。
  0.3~0.5 秒的交叉淡化能完全消除这种痕迹。

为什么同时处理伴奏：
  人声片段剪掉后，伴奏也要剪同样的区间，
  否则人声和伴奏会错位。
"""

import json
import subprocess
import sys
from pathlib import Path

H = Path(r'E:\SoulX-Singer\hikarigage')
SEG_JSON = H / 'good-segments.json'
COVER = H / 'out2' / 'generated.wav'
INST = H / 'sep' / 'inst24k.wav'
SR = 24000

XFADE_SEC = 0.4
OUT_WAV = H / 'soyo-cut.wav'


def main() -> None:
    if not SEG_JSON.exists():
        print(f'缺少段落清单: {SEG_JSON}')
        sys.exit(1)

    segs = json.loads(SEG_JSON.read_text(encoding='utf-8'))
    if not segs:
        print('没有可用段落')
        sys.exit(1)

    print(f'拼接 {len(segs)} 个片段，总时长 {sum(e - s for s, e in segs)}s')
    print(f'交叉淡化 {XFADE_SEC}s\n')

    # 1. 切出每个片段（人声 + 伴奏各一份）
    parts_dir = H / 'parts'
    parts_dir.mkdir(exist_ok=True)

    vocal_parts = []
    inst_parts = []

    for i, (s, e) in enumerate(segs):
        dur = e - s
        vp = parts_dir / f'v{i:02d}.wav'
        ip = parts_dir / f'i{i:02d}.wav'

        for src, dst in ((COVER, vp), (INST, ip)):
            subprocess.run(
                ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
                 '-i', str(src), '-ss', str(s), '-t', str(dur),
                 '-ar', str(SR), '-ac', '1', str(dst)],
                check=True,
            )
        vocal_parts.append(vp)
        inst_parts.append(ip)
        print(f'  [{i}] {s}-{e}s  ({dur}s)')

    # 2. 用 ffmpeg 的 acrossfade 链式拼接
    def concat(parts: list[Path], out: Path, label: str) -> bool:
        if len(parts) == 1:
            subprocess.run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
                            '-i', str(parts[0]), str(out)], check=True)
            return out.exists()

        cmd = ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error']
        for p in parts:
            cmd += ['-i', str(p)]

        # 链式 acrossfade
        filter_parts = []
        prev = '[0:a]'
        for i in range(1, len(parts)):
            outl = f'[a{i}]' if i < len(parts) - 1 else '[out]'
            filter_parts.append(
                f'{prev}[{i}:a]acrossfade=d={XFADE_SEC}:c1=tri:c2=tri{outl}',
            )
            prev = outl

        cmd += ['-filter_complex', ';'.join(filter_parts), '-map', '[out]',
                '-ar', str(SR), '-ac', '1', str(out)]
        r = subprocess.run(cmd, capture_output=True, text=True,
                           encoding='utf-8', errors='replace')
        if not out.exists():
            print(f'  {label} 拼接失败: {r.stderr[-300:]}')
            return False
        return True

    vocal_full = parts_dir / 'vocal-full.wav'
    inst_full = parts_dir / 'inst-full.wav'

    print('\n拼接人声 ...')
    ok_v = concat(vocal_parts, vocal_full, '人声')
    print('拼接伴奏 ...')
    ok_i = concat(inst_parts, inst_full, '伴奏')

    if not (ok_v and ok_i):
        sys.exit(1)

    # 3. 混音
    print('\n混音 ...')
    r = subprocess.run(
        ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
         '-i', str(vocal_full), '-i', str(inst_full),
         '-filter_complex',
         '[0:a]volume=1.05[v];[1:a]volume=0.72[i];'
         '[v][i]amix=inputs=2:duration=first:dropout_transition=0[out]',
         '-map', '[out]', '-ar', str(SR), '-ac', '1', str(OUT_WAV)],
        capture_output=True, text=True,
    )
    if not OUT_WAV.exists():
        print(f'混音失败: {r.stderr[-300:]}')
        sys.exit(1)

    # 4. 响度归一化（-16 LUFS，听感一致）
    norm = H / 'soyo-cut-norm.wav'
    subprocess.run(
        ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
         '-i', str(OUT_WAV), '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
         '-ar', str(SR), '-ac', '1', str(norm)],
        capture_output=True, text=True,
    )

    final = norm if norm.exists() else OUT_WAV
    dur_s = float(subprocess.run(
        ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
         '-of', 'csv=p=0', str(final)],
        capture_output=True, text=True,
    ).stdout.strip() or 0)

    print(f'\n完成: {final}')
    print(f'  时长 {dur_s:.1f}s  大小 {final.stat().st_size / 1024 / 1024:.1f} MB')


if __name__ == '__main__':
    main()

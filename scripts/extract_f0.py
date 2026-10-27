"""用 SoulX 自带的 RMVPE 提取 F0。

SVC 推理需要两个 .npy 文件：音色参考的 F0、目标歌曲的 F0。
这个脚本把音频转成 F0 数组。

用法：
    python extract_f0.py <音频> <输出.npy>
"""

import sys
from pathlib import Path

ROOT = Path(r'E:\SoulX-Singer\SoulX-Singer-main')
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'preprocess' / 'tools'))

RMVPE = Path(r'E:\SoulX-Singer\pretrained_models\rmvpe.pt')


def main() -> None:
    if len(sys.argv) < 3:
        print('用法: python extract_f0.py <音频> <输出.npy>')
        sys.exit(1)

    audio = Path(sys.argv[1])
    out = Path(sys.argv[2])

    if not audio.exists():
        print(f'音频不存在: {audio}')
        sys.exit(1)
    if not RMVPE.exists():
        print(f'RMVPE 权重不存在: {RMVPE}')
        sys.exit(1)

    from f0_extraction import F0Extractor

    ex = F0Extractor(
        model_path=str(RMVPE),
        device='cuda',
        is_half=False,
        input_sr=16000,
        target_sr=24000,
        hop_size=480,
        verbose=True,
    )

    out.parent.mkdir(parents=True, exist_ok=True)
    ex.process(str(audio), f0_path=str(out))

    print(f'完成: {out}')


if __name__ == '__main__':
    main()
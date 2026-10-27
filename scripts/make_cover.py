"""完整的 SVC 翻唱生成脚本（供机器人队列调用）。

流程：
    输入音频（混音）
    → UVR5 分离人声/伴奏
    → 提取两份 F0
    → SoulX-Singer SVC 换音色
    → 混音 + 响度归一化
    → 输出 mp3

用法：
    python make_cover.py --input SONG.mp3 --voice soyo --out OUT.mp3 \
        [--max-seconds 45] [--job-id JOB123]

--max-seconds 限制只处理前 N 秒（用于"简单唱一首"的快路径）。
处理结果会通过 stdout 以 JSON 行报告进度，便于队列解析。
"""

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

# 强制 UTF-8（Windows 默认 GBK，遇到日文会崩）
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

GSV_ROOT = Path(r'E:\GPT-SoVITS\GPT-SoVITS-v4-20250422fix')
SVC_ROOT = Path(r'E:\SoulX-Singer\SoulX-Singer-main')
SVC_PY = Path(r'E:\svc-venv\Scripts\python.exe')
SVC_MODEL = Path(r'E:\SoulX-Singer\pretrained_models\SoulX-Singer\model-svc.pt')
RMVPE = Path(r'E:\SoulX-Singer\pretrained_models\rmvpe.pt')
REF_DIR = Path(r'E:\GPT-SoVITS\ref\mygo')
WORK_ROOT = Path(r'E:\SoulX-Singer\jobs')

SR = 24000


def emit(**kw) -> None:
    """给调用方输出一行 JSON 进度。"""
    print('@@PROGRESS ' + json.dumps(kw, ensure_ascii=False), flush=True)


def ffmpeg(*args: str) -> None:
    subprocess.run(
        ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', *args],
        check=True,
    )


def probe_duration(path: Path) -> float:
    r = subprocess.run(
        ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
         '-of', 'csv=p=0', str(path)],
        capture_output=True, text=True,
    )
    try:
        return float(r.stdout.strip())
    except ValueError:
        return 0.0


def separate_vocals(src: Path, outdir: Path) -> tuple[Path, Path]:
    """UVR5 分离。返回 (人声, 伴奏)。"""
    outdir.mkdir(parents=True, exist_ok=True)
    raw = outdir / '_raw'
    raw.mkdir(exist_ok=True)

    # 已分离过就复用
    voc = outdir / 'vocals.wav'
    inst = outdir / 'inst.wav'
    if voc.exists() and inst.exists():
        emit(stage='separate', status='cached')
        return voc, inst

    script = Path(r'E:\PRO\etc\daliy\whale-chan\scripts\separate_vocals.py')
    # 用 GPT-SoVITS 的 runtime（bs_roformer 装在那里）
    r = subprocess.run(
        [str(GSV_ROOT / 'runtime' / 'python.exe'), str(script), str(src), str(outdir)],
        capture_output=True, text=True, encoding='utf-8', errors='replace',
    )
    if not voc.exists():
        # 兜底：bs_roformer 输出名是 _vocals / _other
        v = next(raw.glob('*vocal*'), None)
        o = next(raw.glob('*other*'), None)
        if v:
            shutil.copy2(v, voc)
        if o:
            shutil.copy2(o, inst)
    if not voc.exists():
        raise RuntimeError(f'人声分离失败: {r.stderr[-400:]}')

    emit(stage='separate', status='done')
    return voc, inst


def extract_f0(audio: Path, out: Path) -> Path:
    """用 svc-venv 的 RMVPE 提 F0。"""
    out.parent.mkdir(parents=True, exist_ok=True)
    script = Path(r'E:\PRO\etc\daliy\whale-chan\scripts\extract_f0.py')
    subprocess.run(
        [str(SVC_PY), str(script), str(audio), str(out)],
        check=True, capture_output=True, text=True,
        encoding='utf-8', errors='replace',
    )
    return out


def run_svc(prompt_wav: Path, prompt_f0: Path, target_wav: Path,
            target_f0: Path, outdir: Path, pitch_shift: int) -> Path:
    outdir.mkdir(parents=True, exist_ok=True)
    cmd = [
        str(SVC_PY), '-m', 'cli.inference_svc',
        '--device', 'cuda',
        '--model_path', str(SVC_MODEL),
        '--config', 'soulxsinger/config/soulxsinger.yaml',
        '--prompt_wav_path', str(prompt_wav),
        '--target_wav_path', str(target_wav),
        '--prompt_f0_path', str(prompt_f0),
        '--target_f0_path', str(target_f0),
        '--save_dir', str(outdir),
        '--pitch_shift', str(pitch_shift),
        '--fp16',
    ]
    r = subprocess.run(cmd, cwd=str(SVC_ROOT), capture_output=True, text=True,
                       encoding='utf-8', errors='replace')
    gen = outdir / 'generated.wav'
    if not gen.exists():
        raise RuntimeError(f'SVC 失败: {r.stderr[-400:]}')
    return gen


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', required=True, help='源音频（混音）')
    ap.add_argument('--voice', default='soyo', help='音色（mygo 目录下的名字）')
    ap.add_argument('--out', required=True, help='输出 mp3 路径')
    ap.add_argument('--max-seconds', type=float, default=0,
                    help='只处理前 N 秒（0 = 全部）')
    ap.add_argument('--pitch-shift', type=int, default=-2,
                    help='变调半音数（默认 -2，接近 soyo 音域）')
    ap.add_argument('--job-id', default='')
    args = ap.parse_args()

    src = Path(args.input)
    out = Path(args.out)
    if not src.exists():
        raise FileNotFoundError(f'源音频不存在: {src}')

    job_dir = WORK_ROOT / (args.job_id or src.stem)
    job_dir.mkdir(parents=True, exist_ok=True)

    total = probe_duration(src)
    limit = args.max_seconds if args.max_seconds > 0 else total
    limit = min(limit, total)
    emit(stage='start', total=round(total, 1), will_process=round(limit, 1))

    # 1. 需要限制时长就先切
    work_src = src
    if limit < total - 0.5:
        work_src = job_dir / 'clip.mp3'
        ffmpeg('-i', str(src), '-t', str(limit), '-ar', str(SR), '-ac', '1',
               str(work_src))
        emit(stage='clip', seconds=round(limit, 1))

    # 2. 分离
    emit(stage='separate', status='running')
    voc, inst = separate_vocals(work_src, job_dir / 'sep')

    # 3. 统一成 24k 单声道
    voc24 = job_dir / 'vocals24k.wav'
    inst24 = job_dir / 'inst24k.wav'
    ffmpeg('-i', str(voc), '-ar', str(SR), '-ac', '1', str(voc24))
    ffmpeg('-i', str(inst), '-ar', str(SR), '-ac', '1', str(inst24))

    # 4. F0
    emit(stage='f0', status='running')
    song_f0 = extract_f0(voc24, job_dir / 'f0' / 'song_f0.npy')

    ref_wav = REF_DIR / f'{args.voice}.wav'
    if not ref_wav.exists():
        raise FileNotFoundError(f'音色不存在: {ref_wav}')

    # 音色参考也可能需要换（原始 mygo.wav 音高偏高）。
    # 若存在 <voice>2.wav 优先用（更贴近原唱音域）。
    better = Path(r'E:\SoulX-Singer\refs') / f'{args.voice}2.wav'
    if better.exists():
        ref_wav = better
    ref_f0 = extract_f0(ref_wav, job_dir / 'f0' / 'ref_f0.npy')

    # 5. SVC
    emit(stage='svc', status='running')
    gen = run_svc(ref_wav, ref_f0, voc24, song_f0, job_dir / 'svc', args.pitch_shift)

    # 6. 混音
    emit(stage='mix', status='running')
    mixed = job_dir / 'mixed.wav'
    ffmpeg('-i', str(gen), '-i', str(inst24),
           '-filter_complex',
           '[0:a]volume=1.05[v];[1:a]volume=0.72[i];'
           '[v][i]amix=inputs=2:duration=first:dropout_transition=0[out]',
           '-map', '[out]', '-ar', str(SR), '-ac', '1', str(mixed))

    # 7. 归一化 + mp3
    out.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg('-i', str(mixed), '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
           '-b:a', '160k', str(out))

    dur = probe_duration(out)
    emit(stage='done', out=str(out), duration=round(dur, 1))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as e:  # noqa: BLE001
        emit(stage='error', message=str(e)[:400])
        sys.exit(1)

"""把 voicemodel 里训练好的 MYGO 模型接入 GPT-SoVITS。

做三件事：
  1. 扫描每个角色的参考音频（3~10 秒）
  2. 复制 GPT / SoVITS 权重到 GPT-SoVITS 的搜索目录
  3. 用 API 逐个验证能否切换并合成

为什么要复制：GPT-SoVITS 的 set_*_weights 接口只接受它自己目录下的相对路径，
          而且对中文路径支持有 bug（实测报 not exists）。
"""

import json
import shutil
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path

VM = Path(r'E:\PRO\etc\daliy\whale-chan\voicemodel')
GSV = Path(r'E:\GPT-SoVITS\GPT-SoVITS-v4-20250422fix')
REF_OUT = Path(r'E:\GPT-SoVITS\ref\mygo')
API = 'http://127.0.0.1:9880'

# 角色 → (GPT 权重名, SoVITS 权重名, 参考音频子目录)
CHARS = {
    'anon':   ('anon1-e15.ckpt',      'anon1_e8_s2184.pth',      'Anon干声素材'),
    'soyo':   ('soyo1-e20.ckpt',      'soyo1_e12_s1428.pth',     'Soyo干声素材'),
    'tomori': ('tomori1-e20.ckpt',    'tomori1_e12_s2664.pth',   'Tomori干声素材'),
    'taki':   ('riki1-e15.ckpt',      'riki1_e8_s3128.pth',      'Taki干声素材'),
    'rana':   ('rana1-e20.ckpt',      'rana1_e12_s1176.pth',     'Rana干声素材'),
    'sakiko': ('sakiko1-e15.ckpt',    'sakiko1_e8_s560.pth',     'sakiko'),
}


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


def pick_ref(sub: str) -> tuple[Path, str] | None:
    """挑一段 3~10 秒的参考音频，返回 (路径, 从文件名推的文本)。"""
    d = VM / '参考音频' / sub
    if not d.exists():
        return None

    best = None
    for f in d.rglob('*.wav'):
        # 跳过自动切分的（xxx.WAV_000123_000456.wav）
        if '.WAV_' in f.name.upper():
            continue
        dd = dur(f)
        if not (3.0 <= dd <= 10.0):
            continue
        # 优先 4~6 秒（太短信息不够、太长可能多人）
        score = abs(dd - 5.0)
        if best is None or score < best[0]:
            best = (score, f, dd)

    if best is None:
        return None

    # 从文件名推参考文本（去掉扩展名和末尾的省略号/句号）
    stem = best[1].stem
    text = stem.rstrip('。.…、').strip()
    return best[1], text


def call_api(path: str, params: dict | None = None) -> dict:
    url = f'{API}{path}'
    if params:
        url += '?' + urllib.parse.urlencode(params)
    try:
        with urllib.request.urlopen(url, timeout=180) as r:
            return json.loads(r.read().decode('utf-8'))
    except Exception as e:  # noqa: BLE001
        return {'error': str(e)}


def main() -> None:
    REF_OUT.mkdir(parents=True, exist_ok=True)
    results = []

    for name, (gpt, sovits, sub) in CHARS.items():
        print(f'\n=== {name} ===', flush=True)

        # 1) 拷权重
        gpt_src = VM / 'GPT_weights' / gpt
        sov_src = VM / 'SoVITS_weights' / sovits
        if not gpt_src.exists():
            print(f'  缺 GPT 权重: {gpt_src}')
            continue
        if not sov_src.exists():
            print(f'  缺 SoVITS 权重: {sov_src}')
            continue

        shutil.copy2(gpt_src, GSV / 'GPT_weights' / gpt)
        shutil.copy2(sov_src, GSV / 'SoVITS_weights' / sovits)
        print(f'  权重已复制')

        # 2) 挑参考音频并复制到 ASCII 路径
        picked = pick_ref(sub)
        if picked is None:
            print(f'  没找到 3~10 秒的参考音频')
            continue
        ref_path, ref_text = picked
        ref_dst = REF_OUT / f'{name}.wav'
        shutil.copy2(ref_path, ref_dst)
        print(f'  参考: {ref_path.name}  {dur(ref_dst):.2f}s')
        print(f'  文本: {ref_text}')

        # 3) 切权重
        r1 = call_api('/set_gpt_weights', {'weights_path': f'GPT_weights/{gpt}'})
        r2 = call_api('/set_sovits_weights', {'weights_path': f'SoVITS_weights/{sovits}'})
        print(f'  切换: gpt={r1.get("message", r1)}  sovits={r2.get("message", r2)}')

        results.append({
            'id': name,
            'name': name,
            'gpt': gpt,
            'sovits': sovits,
            'refAudio': str(ref_dst),
            'refText': ref_text,
            'refDur': round(dur(ref_dst), 2),
            'lang': 'ja',
        })

    # 存成音色配置（给 gsv_server.py 用）
    out = REF_OUT / 'mygo-voices.json'
    out.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'\n已写入 {out}')

    # 顺便测试第一个
    if results:
        v = results[0]
        print(f'\n=== 试合成 {v["id"]} ===')
        body = {
            'text': '你好呀，我是千早爱音，今天天气真不错呢。',
            'text_lang': 'zh',
            'ref_audio_path': v['refAudio'],
            'prompt_text': v['refText'],
            'prompt_lang': 'ja',
            'text_split_method': 'cut5',
            'batch_size': 1,
            'media_type': 'wav',
            'streaming_mode': False,
        }
        req = urllib.request.Request(
            f'{API}/tts',
            data=json.dumps(body, ensure_ascii=False).encode('utf-8'),
            headers={'Content-Type': 'application/json'},
            method='POST',
        )
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                data = r.read()
            outwav = Path(r'E:\PRO\etc\daliy\whale-chan\test-ft.wav')
            outwav.write_bytes(data)
            print(f'  成功: {outwav}  ({len(data)} bytes)')
        except Exception as e:  # noqa: BLE001
            detail = ''
            if hasattr(e, 'read'):
                detail = e.read().decode('utf-8', errors='replace')[:300]
            print(f'  失败: {e} {detail}')


if __name__ == '__main__':
    main()

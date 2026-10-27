"""GPT-SoVITS 后端适配服务（支持微调模型 + 零样本克隆）。

统一接口（和 tts_server.py 一致，机器人侧不用改）：
    GET  /health
    GET  /voices
    POST /voice     {"name": "anon"}
    POST /tts       {"text": "...", "voice": "anon"}
                   → {"ok": true, "path": "...", "duration": 4.3}

两种音色来源：
  1. 微调模型（质量最高）——带 gpt/sovits 权重，需要 set_*_weights
  2. 零样本克隆——只有参考音频，用默认权重

配置文件：E:\GPT-SoVITS\ref\mygo\mygo-voices.json
          （由 setup_mygo.py 生成）

切权重有开销（每个 1~3 秒），所以缓存「当前已加载的权重」，
同一音色连续请求不重复切换。
"""

import sys
import io

# Windows 下 Python 默认用 GBK 写 stdout，
# 一旦日志里出现日文（如 〜 U+301C）就抛 UnicodeEncodeError，
# 而且这个异常会冒泡到 /tts 接口，让整个合成失败。
# 所以必须在任何 print 之前把 stdout/stderr 切成 UTF-8。
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

from flask import Flask, jsonify, request

GSV_API = 'http://127.0.0.1:9880'
VOICES_JSON = Path(r'E:\GPT-SoVITS\ref\mygo\mygo-voices.json')
EMO_JSON = Path(r'E:\GPT-SoVITS\ref\emo\emotion-voices.json')
QUALITY_JSON = Path(r'E:\GPT-SoVITS\ref\emo\quality.json')
EXTRA_DIR = Path(r'E:\GPT-SoVITS\ref')          # 零样本音色（*.json + 参考音频）
OUTPUT_DIR = Path(r'E:\tts-venv\output')
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

app = Flask(__name__, static_folder=None)

_current: str = ''
_loaded: dict[str, str] = {}   # {'gpt': path, 'sovits': path} 当前已加载
_emotions: dict[str, dict[str, dict]] = {}   # 启动时加载的情绪库

GEN_PARAMS = {
    'text_split_method': 'cut5',
    'batch_size': 1,
    'media_type': 'wav',
    'streaming_mode': False,
    'speed_factor': 1.0,
    'temperature': 1.0,
    'top_k': 15,
    'top_p': 1.0,
}


def detect_lang(text: str) -> str:
    """自动判断文本语言。

    为什么必须自动判断：text_lang 传错会导致音素和参考音频对不上，
    模型只吐出 0.3~0.5 秒的杂音（实测 soyo 用 zh 就是这样）。

    判断顺序：假名 → 日语；纯 ASCII 字母 → 英语；否则中文。
    混合文本（中日混排）优先判成日语，因为假名的决定性更强。
    """
    # 平假名 U+3040-309F / 片假名 U+30A0-30FF
    if re.search(r'[\u3040-\u309F\u30A0-\u30FF]', text):
        return 'ja'
    # 谚文
    if re.search(r'[\uAC00-\uD7AF]', text):
        return 'ko'
    # 有汉字 → 中文
    if re.search(r'[\u4E00-\u9FFF]', text):
        return 'zh'
    # 纯 ASCII
    if re.search(r'[A-Za-z]', text):
        return 'en'
    return 'zh'


def load_emotions() -> dict[str, dict[str, dict]]:
    """加载情绪参考音频库：{角色: {情绪: 配置}}。

    原理：GPT-SoVITS 没有情绪参数，情绪完全来自参考音频。
    实测同一句话用不同参考，F0 均值能差 100Hz（兴奋 381Hz / 失落 287Hz）。

    【重要】只加载「音色不跑偏」的那些。
    check_emotion_quality.py 会算每段情绪参考与角色默认参考的 MFCC 距离，
    距离超过阈值的会带偏音色（实测 sakiko 的 calm 参考距离 103.95，
    合成出来完全不像祥子）。所以这里过滤掉不可用的。
    """
    if not EMO_JSON.exists():
        return {}

    # 先读质量报告（没有就不过滤）
    usable = None
    if QUALITY_JSON.exists():
        try:
            q = json.loads(QUALITY_JSON.read_text(encoding='utf-8'))
            usable = {item['id'] for item in q if item.get('usable')}
            print(f'[GSV] 情绪质量过滤：{len(usable)} 条通过', flush=True)
        except Exception as e:  # noqa: BLE001
            print(f'[GSV] 读质量报告失败，不过滤: {e}', flush=True)

    try:
        data = json.loads(EMO_JSON.read_text(encoding='utf-8'))
    except Exception as e:  # noqa: BLE001
        print(f'[GSV] 读 {EMO_JSON} 失败: {e}', flush=True)
        return {}

    out: dict[str, dict[str, dict]] = {}
    skipped = 0
    for e in data:
        char = e.get('character') or ''
        emo = e.get('emotion') or ''
        if not char or not emo:
            continue
        if usable is not None and e.get('id') not in usable:
            skipped += 1
            continue
        audio = Path(e['refAudio'])
        if not audio.exists():
            continue
        out.setdefault(char, {})[emo] = {
            'refAudio': str(audio),
            'refText': e.get('refText', ''),
            'refDur': e.get('refDur', 0),
        }

    if skipped:
        print(f'[GSV] 跳过 {skipped} 条音色跑偏的情绪参考', flush=True)
    return out


def pick_ref(v: dict, emotion: str | None) -> tuple[str, str, str]:
    """按情绪挑参考音频。

    返回 (音频路径, 参考文本, 实际用的情绪)。

    【重要设计决策】找不到对应情绪时，**直接退回角色默认参考**，
    不再用「相近情绪」兜底。

    原因（用户实测反馈）：用相近情绪兜底反而更糟。
    例：sakiko 没有 happy → 兜底到 calm（距离 103.95）→ 完全不像祥子；
        而默认参考 sakiko.wav 距离只有 30.67，听起来最像。
    所以「没有该情绪」时宁可不表现情绪，也要保住音色。
    """
    if not emotion:
        return v['refAudio'], v['refText'], 'default'

    emos = _emotions.get(v['id'], {})
    hit = emos.get(emotion)
    if hit:
        return hit['refAudio'], hit['refText'], emotion

    # 没有这个情绪 → 保音色优先，退回默认参考
    return v['refAudio'], v['refText'], f'default(no-{emotion})'


def load_voices() -> list[dict]:
    """加载所有音色（微调模型 + 零样本）。"""
    voices: list[dict] = []

    # 1) 微调模型
    if VOICES_JSON.exists():
        try:
            data = json.loads(VOICES_JSON.read_text(encoding='utf-8'))
            for v in data:
                voices.append({
                    'id': v['id'],
                    'name': v.get('name') or v['id'],
                    'language': v.get('lang', 'ja'),
                    'refAudio': v['refAudio'],
                    'refText': v['refText'],
                    'gpt': v.get('gpt'),
                    'sovits': v.get('sovits'),
                    'kind': 'finetuned' if v.get('gpt') else 'zero-shot',
                })
        except Exception as e:  # noqa: BLE001
            print(f'[GSV] 读 {VOICES_JSON} 失败: {e}', flush=True)

    # 2) 零样本（refs 根目录下的 *.json）
    for cfg in sorted(EXTRA_DIR.glob('*.json')):
        try:
            j = json.loads(cfg.read_text(encoding='utf-8'))
            audio = EXTRA_DIR / j['audio']
            if not audio.exists():
                continue
            if any(v['id'] == cfg.stem for v in voices):
                continue
            voices.append({
                'id': cfg.stem,
                'name': j.get('name') or cfg.stem,
                'language': j.get('lang', 'zh'),
                'refAudio': str(audio),
                'refText': j.get('text', ''),
                'gpt': None,
                'sovits': None,
                'kind': 'zero-shot',
            })
        except Exception as e:  # noqa: BLE001
            print(f'[GSV] 跳过 {cfg.name}: {e}', flush=True)

    return voices


def get_voice(vid: str) -> dict | None:
    for v in load_voices():
        if v['id'] == vid:
            return v
    return None


def default_voice() -> str:
    vs = load_voices()
    return vs[0]['id'] if vs else ''


def gsv_get(path: str, params: dict | None = None, timeout: int = 180) -> dict:
    url = f'{GSV_API}{path}'
    if params:
        url += '?' + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


def ensure_weights(v: dict) -> None:
    """切换权重（已加载则跳过）。仅微调模型需要。"""
    gpt = v.get('gpt')
    sovits = v.get('sovits')
    if not gpt and not sovits:
        return

    if gpt and _loaded.get('gpt') != gpt:
        gsv_get('/set_gpt_weights', {'weights_path': f'GPT_weights/{gpt}'})
        _loaded['gpt'] = gpt
        print(f'[GSV] 切换 GPT 权重 -> {gpt}', flush=True)

    if sovits and _loaded.get('sovits') != sovits:
        gsv_get('/set_sovits_weights', {'weights_path': f'SoVITS_weights/{sovits}'})
        _loaded['sovits'] = sovits
        print(f'[GSV] 切换 SoVITS 权重 -> {sovits}', flush=True)


@app.get('/health')
def health():
    vs = load_voices()
    return jsonify({
        'ok': True,
        'backend': 'gpt-sovits',
        'current': _current or default_voice(),
        'voices': len(vs),
        'loaded': _loaded,
        'device': 'cuda',
    })


@app.get('/voices')
def voices():
    return jsonify({
        'ok': True,
        'backend': 'gpt-sovits',
        'voices': load_voices(),
        'current': _current or default_voice(),
    })


@app.post('/voice')
def switch_voice():
    global _current
    data = request.get_json(silent=True) or {}
    name = (data.get('name') or '').strip()
    v = get_voice(name)
    if not v:
        return jsonify({'ok': False, 'message': f'音色不存在: {name}'}), 400
    try:
        ensure_weights(v)
        _current = name
        return jsonify({'ok': True, 'current': name, 'kind': v['kind']})
    except Exception as e:  # noqa: BLE001
        return jsonify({'ok': False, 'message': str(e)}), 500


@app.post('/tts')
def tts():
    global _current
    data = request.get_json(silent=True) or {}
    text = (data.get('text') or '').strip()
    vid = (data.get('voice') or '').strip() or _current or default_voice()

    if not text:
        return jsonify({'ok': False, 'message': 'text 为空'}), 400
    if len(text) > 300:
        text = text[:300]

    v = get_voice(vid)
    if not v:
        vs = load_voices()
        if not vs:
            return jsonify({'ok': False, 'message': '没有可用音色'}), 500
        v = vs[0]

    t0 = time.time()
    try:
        ensure_weights(v)

        # 按情绪挑参考音频（GPT-SoVITS 没有情绪参数，情绪只能靠参考音频带）
        emotion = (data.get('emotion') or '').strip() or None
        ref_audio, ref_text, used_emo = pick_ref(v, emotion)

        payload = {
            'text': text,
            'text_lang': detect_lang(text),
            'ref_audio_path': ref_audio,
            'prompt_text': ref_text,
            'prompt_lang': v['language'],
            **GEN_PARAMS,
        }
        req = urllib.request.Request(
            f'{GSV_API}/tts',
            data=json.dumps(payload, ensure_ascii=False).encode('utf-8'),
            headers={'Content-Type': 'application/json'},
            method='POST',
        )
        with urllib.request.urlopen(req, timeout=300) as r:
            audio = r.read()
        gen_sec = time.time() - t0

        if audio[:4] != b'RIFF':
            preview = audio[:200].decode('utf-8', errors='replace')
            print(f'[GSV] 非音频响应: {preview}', flush=True)
            return jsonify({'ok': False, 'message': 'GPT-SoVITS 返回异常'}), 500

        name = f'gsv-{uuid.uuid4().hex[:12]}.wav'
        out = OUTPUT_DIR / name
        out.write_bytes(audio)

        dur = 0.0
        try:
            import soundfile as sf
            dur = sf.info(str(out)).duration
        except Exception:  # noqa: BLE001
            pass

        _current = v['id']
        print(
            f'[GSV] {v["id"]}({v["kind"]}) "{text[:20]}" -> {name}  '
            f'{dur:.1f}s / {gen_sec:.1f}s',
            flush=True,
        )

        return jsonify({
            'ok': True,
            'path': str(out).replace('\\', '/'),
            'duration': round(dur, 2),
            'genSec': round(gen_sec, 2),
            'voice': v['id'],
            'kind': v['kind'],
            'emotion': used_emo,
            'backend': 'gpt-sovits',
        })

    except urllib.error.HTTPError as e:
        detail = e.read().decode('utf-8', errors='replace')[:300]
        print(f'[GSV] HTTP {e.code}: {detail}', flush=True)
        return jsonify({'ok': False, 'message': detail}), 500
    except Exception as e:  # noqa: BLE001
        print(f'[GSV] 失败: {e}', flush=True)
        return jsonify({'ok': False, 'message': str(e)}), 500


if __name__ == '__main__':
    port = int(os.environ.get('GSV_PORT', '5051'))
    _emotions = load_emotions()
    vs = load_voices()
    print(f'[GSV] 启动 http://127.0.0.1:{port}', flush=True)
    print(f'[GSV] {len(vs)} 个音色: {", ".join(v["id"] for v in vs)}', flush=True)
    for v in vs:
        emos = list(_emotions.get(v['id'], {}).keys())
        print(f'[GSV]   {v["id"]:8} {v["kind"]:10} 情绪={len(emos)} ({",".join(emos) or "无"})', flush=True)
    app.run(host='127.0.0.1', port=port, threaded=False)

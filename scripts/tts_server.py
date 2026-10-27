"""多音色 TTS 服务（Style-Bert-VITS2）。

特性：
  - 多音色切换（扫描 models/ 下每个子目录作为一个音色）
  - 自然度优化参数（intonation_scale=1.5，实测音域 +43%）
  - 懒加载 + 缓存（切换音色才重新加载，同一音色复用）
  - 常驻，避免每次 17 秒冷启动

接口：
    GET  /health                健康检查 + 当前音色
    GET  /voices                列出所有可用音色
    POST /voice                 切换音色 {"name": "RikkaBotan_ZH"}
    POST /tts                   合成 {"text": "...", "voice": "可选"}
                                → {"ok": true, "path": "...", "duration": 5.0}
"""

import sys
import io

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

import os
import time
import uuid
from pathlib import Path

from flask import Flask, jsonify, request

MODEL_ROOT = Path(r'E:\tts-venv\models')
OUTPUT_DIR = Path(r'E:\tts-venv\output')
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

app = Flask(__name__, static_folder=None)

# 已加载的模型缓存：voice_name -> TTSModel
_models: dict[str, object] = {}
_bert_ready = False
_current = None

# 自然度参数（实测最优，见 tts_analyze.py 的客观分析）
# intonation_scale 1.0 -> 1.5 让音域从 4.14 半音扩到 5.94 半音（+43%）
TTS_PARAMS = {
    'sdp_ratio': 0.05,
    'noise': 0.7,
    'noise_w': 0.85,
    'length': 1.15,
    'intonation_scale': 1.5,   # 语调起伏，机械感的主要解药
    'pitch_scale': 1.05,
    'style': 'Neutral',
    'line_split': True,
    'split_interval': 0.6,
}


def scan_voices() -> list[dict]:
    """扫描 models/ 下的音色目录（含 config.json + safetensors 才算）。"""
    voices = []
    if not MODEL_ROOT.exists():
        return voices

    for d in sorted(MODEL_ROOT.iterdir()):
        if not d.is_dir():
            continue
        config = d / 'config.json'
        style_vec = d / 'style_vectors.npy'
        models = list(d.glob('*.safetensors'))
        if config.exists() and style_vec.exists() and models:
            try:
                import json
                cfg = json.loads(config.read_text(encoding='utf-8'))
                name = cfg.get('model_name') or cfg.get('data', {}).get('spk2id', {}) or d.name
                if isinstance(name, dict):
                    name = next(iter(name.keys()), d.name)
            except Exception:  # noqa: BLE001
                name = d.name

            voices.append({
                'id': d.name,
                'name': str(name),
                'file': models[0].name,
                'language': 'zh' if 'ZH' in d.name.upper() or 'chinese' in d.name.lower() else 'unknown',
            })
    return voices


def ensure_bert() -> None:
    global _bert_ready
    if _bert_ready:
        return
    from style_bert_vits2.nlp import bert_models
    from style_bert_vits2.constants import Languages

    t = time.time()
    bert_models.load_model(Languages.ZH)
    bert_models.load_tokenizer(Languages.ZH)
    print(f'[TTS] BERT 加载完成 {time.time()-t:.1f}s', flush=True)
    _bert_ready = True


def ensure_model(voice_id: str):
    """加载指定音色（已加载则复用）。"""
    global _current
    ensure_bert()

    if voice_id in _models:
        _current = voice_id
        return _models[voice_id]

    d = MODEL_ROOT / voice_id
    if not d.exists():
        raise FileNotFoundError(f'音色不存在: {voice_id}')

    config = d / 'config.json'
    style_vec = d / 'style_vectors.npy'
    models = list(d.glob('*.safetensors'))
    if not models:
        raise FileNotFoundError(f'{voice_id} 里没有 safetensors')

    from style_bert_vits2.tts_model import TTSModel

    t = time.time()
    model = TTSModel(
        model_path=str(models[0]),
        config_path=str(config),
        style_vec_path=str(style_vec),
        device='cpu',
    )
    model.load()
    _models[voice_id] = model
    _current = voice_id
    print(f'[TTS] 音色 {voice_id} 加载完成 {time.time()-t:.1f}s', flush=True)
    return model


def default_voice() -> str:
    voices = scan_voices()
    return voices[0]['id'] if voices else ''


@app.get('/health')
def health():
    voices = scan_voices()
    return jsonify({
        'ok': True,
        'loaded': list(_models.keys()),
        'current': _current or default_voice(),
        'voices': len(voices),
        'device': 'cpu',
    })


@app.get('/voices')
def voices():
    return jsonify({
        'ok': True,
        'voices': scan_voices(),
        'current': _current or default_voice(),
    })


@app.post('/voice')
def switch_voice():
    data = request.get_json(silent=True) or {}
    name = (data.get('name') or '').strip()
    if not name:
        return jsonify({'ok': False, 'message': '缺 name'}), 400

    try:
        ensure_model(name)
        return jsonify({'ok': True, 'current': name})
    except Exception as e:  # noqa: BLE001
        return jsonify({'ok': False, 'message': str(e)}), 500


@app.post('/tts')
def tts():
    data = request.get_json(silent=True) or {}
    text = (data.get('text') or '').strip()
    voice = (data.get('voice') or '').strip() or _current or default_voice()

    if not text:
        return jsonify({'ok': False, 'message': 'text 为空'}), 400
    if len(text) > 300:
        text = text[:300]

    try:
        model = ensure_model(voice)

        from style_bert_vits2.constants import Languages

        t0 = time.time()
        sr, audio = model.infer(
            text=text,
            language=Languages.ZH,
            **TTS_PARAMS,
        )
        gen_sec = time.time() - t0

        name = f'tts-{uuid.uuid4().hex[:12]}.wav'
        out = OUTPUT_DIR / name

        import soundfile as sf
        sf.write(str(out), audio, sr)

        dur = len(audio) / sr
        print(
            f'[TTS] {voice} "{text[:20]}" -> {name}  '
            f'{dur:.1f}s 音频 / {gen_sec:.1f}s 生成',
            flush=True,
        )

        return jsonify({
            'ok': True,
            'path': str(out).replace('\\', '/'),
            'duration': round(dur, 2),
            'genSec': round(gen_sec, 2),
            'voice': voice,
        })
    except Exception as e:  # noqa: BLE001
        print(f'[TTS] 失败: {e}', flush=True)
        import traceback
        traceback.print_exc()
        return jsonify({'ok': False, 'message': str(e)}), 500


if __name__ == '__main__':
    port = int(os.environ.get('TTS_PORT', '5050'))
    vs = scan_voices()
    print(f'[TTS] 启动服务 http://127.0.0.1:{port}', flush=True)
    print(f'[TTS] 发现 {len(vs)} 个音色: {", ".join(v["id"] for v in vs)}', flush=True)
    print('[TTS] 参数: intonation_scale=1.5 (自然度优化)', flush=True)
    app.run(host='127.0.0.1', port=port, threaded=False)

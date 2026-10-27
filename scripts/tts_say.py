"""用 RikkaBotan 中文萌系音色合成语音。

用法：
    python tts_say.py "要说的中文" 输出.wav
"""
import sys
import time
from pathlib import Path

MODEL_DIR = Path(r'E:\tts-venv\models\RikkaBotan_ZH')


def main() -> int:
    if len(sys.argv) < 3:
        print('用法: python tts_say.py "文本" 输出.wav')
        return 1

    text = sys.argv[1]
    out = Path(sys.argv[2])
    t0 = time.time()

    from style_bert_vits2.nlp import bert_models
    from style_bert_vits2.constants import Languages

    print('[1/3] 加载 BERT ...')
    bert_models.load_model(Languages.ZH)
    bert_models.load_tokenizer(Languages.ZH)
    print(f'      耗时 {time.time()-t0:.1f}s')

    from style_bert_vits2.tts_model import TTSModel

    print('[2/3] 加载 TTS 模型 ...')
    t1 = time.time()
    model = TTSModel(
        model_path=str(MODEL_DIR / 'rikka_botan_chinese.safetensors'),
        config_path=str(MODEL_DIR / 'config.json'),
        style_vec_path=str(MODEL_DIR / 'style_vectors.npy'),
        device='cpu',
    )
    model.load()
    print(f'      耗时 {time.time()-t1:.1f}s')

    print('[3/3] 合成 ...')
    t2 = time.time()
    # 注意参数名：新版用 noise / noise_w / length，不是 noise_scale 等
    sr, audio = model.infer(
        text=text,
        language=Languages.ZH,
        style='Neutral',
        sdp_ratio=0.2,
        noise=0.6,
        noise_w=0.8,
        length=1.0,
        line_split=True,
    )
    print(f'      耗时 {time.time()-t2:.1f}s  采样率 {sr}  样本数 {len(audio)}')

    import soundfile as sf
    sf.write(str(out), audio, sr)
    dur = len(audio) / sr
    print(f'\n完成: {out}  ({dur:.1f} 秒音频, 总耗时 {time.time()-t0:.1f}s)')
    return 0


if __name__ == '__main__':
    sys.exit(main())

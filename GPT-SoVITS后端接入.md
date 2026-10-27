# GPT-SoVITS 后端接入

完成时间：2026-10-24

---

## 一、结果：切到 GPT-SoVITS 了

| | SBV2（原） | GPT-SoVITS（新） |
|---|---|---|
| 合成 3.5 秒音频 | 2.5 秒 | **2.5 秒** |
| 合成 11.5 秒音频 | ~7 秒 | **15.4 秒** ⚠️ |
| 音色来源 | 独立模型文件 | **参考音频克隆** |
| 音域（半音） | 5.80 | 5.82 |

**短句速度相当，长句 GPT-SoVITS 慢一些**（因为文本切分 + 逐句生成）。
但音质更接近真人，这也是换后端的初衷。

---

## 二、架构：两套后端并存

```
机器人
  └─ TTS_BASE_URL → http://127.0.0.1:5051  （GSV 适配层）
                        └─ http://127.0.0.1:9880 （GPT-SoVITS 原生 API）

备用：
  http://127.0.0.1:5050  （SBV2）
```

| 端口 | 服务 | 说明 |
|---|---|---|
| **9880** | GPT-SoVITS 原生 API | 需要每次带参考音频+文本 |
| **5051** | GSV 适配层 | 把参考音频抽象成"音色"，接口对齐 SBV2 |
| 5050 | SBV2 | 备用，控制面板仍可切 |

**为什么加适配层**：GPT-SoVITS 原生 API 每次请求都要传
`ref_audio_path` + `prompt_text` + `prompt_lang`，
而 SBV2 是"选一个模型 ID"。

5051 把这件事统一了：

```
E:\GPT-SoVITS\ref\
  ├── rikka.json          ← 一个音色 = 一份配置
  │   {"name":"...", "audio":"rikka-ref8s.wav", "text":"参考文本", "lang":"zh"}
  └── rikka-ref8s.wav     ← 参考音频（3~10 秒）
```

机器人侧的 `TtsClient` 完全不用改。

---

## 三、安装过程

### 下载

```
ModelScope: FlowerCry/gpt-sovits-7z-pacakges
文件: GPT-SoVITS-v4-20250422fix.7z
大小: 7.01 GB
速度: 21 MB/s（ModelScope 免代理，比 HF 快 20 倍）
耗时: 约 6 分钟
```

### 解压

用 `7zr.exe`（7-Zip 精简版，588 KB）：

```
E:\7zr.exe x E:\GPT-SoVITS-v4.7z -oE:\GPT-SoVITS -y
耗时 6.1 分钟
```

### 自带环境

整合包**自带完整 Python 环境**，不用另装：

```
runtime\python.exe  → Python 3.9.13
torch 2.0.0+cu118
cuda True
```

依赖全齐（transformers / librosa / pytorch_lightning / onnxruntime / jieba / cn2an / LangSegment）。

### 预训练模型也已包含

```
GPT_SoVITS\pretrained_models\
  ├── chinese-hubert-base\
  ├── chinese-roberta-wwm-ext-large\
  ├── gsv-v2final-pretrained\
  ├── gsv-v4-pretrained\
  └── fast_langdetect\
```

**开箱即用，不需要额外下载。**

---

## 四、踩的两个坑

### 1. 参考音频必须在 3~10 秒

```
Exception: 参考音频在3~10秒范围外，请更换！
```

我最初用 SBV2 生成的 13.49 秒音频，直接被拒。
**修复**：`ffmpeg -t 8` 裁到 8 秒。

注意：**裁了音频也要同步裁参考文本**，否则音素对不齐。

### 2. 音色配置 JSON 的 BOM

`PowerShell` 的 `Set-Content -Encoding UTF8` 会写 BOM，
Python 的 `json.loads` 直接报错：

```
Unexpected UTF-8 BOM (decode using utf-8-sig)
```

**修复**：用 `[Text.UTF8Encoding]::new($false)` 写无 BOM 的 UTF-8。

---

## 五、启动脚本

`scripts/start-tts.ps1` 现在一次拉起三套：

```
1. GPT-SoVITS 原生 API（9880）  ← 加载模型约 30 秒
2. GSV 适配层（5051）            ← 6 秒
3. SBV2（5050，备用）            ← 6 秒
```

每套都会先探测端口，已在运行就跳过。

watchdog 的 `Test-TtsPort` 改为检查 **5051**（机器人实际用的后端），
挂了就调 `start-tts.ps1` 全部拉起。

---

## 六、音色管理

### 添加新音色（比如 MYGO 角色）

只要三样东西：

1. **参考音频**（3~10 秒，干净人声，无伴奏）
2. **参考文本**（音频里说的内容，必须一字不差）
3. 一份 JSON 配置

```
E:\GPT-SoVITS\ref\anon.json
{
  "name": "千早爱音",
  "audio": "anon-ref.wav",
  "text": "参考音频里说的那句话",
  "lang": "ja"        ← 日语用 ja
}
```

放进 `refs\` 目录，重启 5051（或等 watchdog 拉起），
控制面板的音色列表就会多一项。

### 支持的语言

GPT-SoVITS 原生支持：
- 中文 `zh`
- 英文 `en`
- **日语 `ja`**
- 韩语 `ko`
- 粤语 `yue`

**所以日语歌/日语对话都能做**，比 SBV2 更全。

---

## 七、关于"上午的语音效果很差"

客观数据：

| 后端 | 时长 | 音域（半音） |
|---|---|---|
| SBV2（优化前） | 9.09s | 4.14 |
| SBV2（优化后） | 10.34s | 5.60 |
| GPT-SoVITS | 4.32s | 5.82 |

音域只提升了一点，但**听感差异主要来自音质**，不是音域：
- SBV2 是 VITS 系（快但略带电子味）
- GPT-SoVITS 是 GPT + VITS 融合（更接近真人呼吸感）

**我已经把三条语音发到群里了**，你可以直接对比：
1. 上午的 SBV2 旧参数
2. 优化的 SBV2（intonation 1.5）
3. GPT-SoVITS 克隆版

---

## 八、文件清单

| 文件 | 说明 |
|---|---|
| `scripts/start-tts.ps1` | 重写：一次拉起三套服务 |
| `scripts/gsv_server.py` | 新增：GSV 适配层（5051） |
| `scripts/tts_server.py` | SBV2 服务（5050，备用） |
| `E:\GPT-SoVITS\ref\*.json` | 音色配置 |
| `E:\GPT-SoVITS\ref\*.wav` | 参考音频 |
| `.env` | `TTS_BASE_URL=http://127.0.0.1:5051` |
| `scripts/watchdog.ps1` | `Test-TtsPort` 改查 5051 |

全量测试：**308 个**，全部通过。

---

## 九、当前服务状态

| 端口 | 服务 | 状态 |
|---|---|---|
| 3001 | OneBot | ✅ |
| 5051 | GSV 适配层 | ✅ |
| 9880 | GPT-SoVITS API | ✅ |
| 8188 | ComfyUI 生图 | ✅ |
| 8787 | 控制面板 | ✅ |
| 5050 | SBV2（备用） | 未启动 |

---

## 十、下一步

| 要做 | 说明 |
|---|---|
| **接入 MYGO 音色** | 找参考音频（3~10 秒干净人声）→ 写 JSON → 放进 refs |
| **唱歌** | GPT-SoVITS 只管说话，唱歌还得走 SVC（SoulX-Singer） |
| **控制面板后端切换** | 现在要改 .env 重启；可以做成面板上点一下 |

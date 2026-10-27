# TTS 方案选型与实施计划

调研时间：2026-10-24

---

## 一、找到了最合适的音色

**`RikkaBotan/style_bert_vits2_chinese_original`**

| 项目 | 值 |
|---|---|
| 语言 | **中文** ✅ |
| 风格 | **childish（稚气萌系）** ✅ |
| 许可 | **CC-BY-SA 4.0** ✅ 商用非商用免费 |
| 模型大小 | **189.6 MB**（很轻） |
| 采样率 | 44100 Hz |
| 架构版本 | Style-Bert-VITS2 v2.4.1 |

**这就是你要的「开源萌系音色」。**

README 原文：
> 这种模式的优势在于，生成的稚气平和的声音可以免费用于商业和非商业目的。
> The advantage of this model is that you can freely use the childish and unapologetic voice generation for free, both commercial and non-commercial.

**没有版权风险**：作者明确授权免费使用。

---

## 二、但有个环境难题

Style-Bert-VITS2 的依赖要求：

```
torch<2.4
torchaudio<2.4
numpy<2
pyannote.audio>=3.1.0
transformers
onnxruntime-gpu
```

而我们现在的情况：

| 环境 | Python | torch | numpy |
|---|---|---|---|
| **ComfyUI venv** | 3.13.14 | 2.11.0 | 2.x |
| 系统 | 3.13.14 | — | — |
| 可用 Python | **3.12.11**（uv 装的） | — | — |

**问题**：
1. SBV2 要 torch<2.4，comfy venv 是 2.11 → **必须独立 venv**
2. Python 3.13 太新，torch<2.4 **没有 cp313 的 wheel**
3. 只能退回 **Python 3.12.11**（本机有）

---

## 三、方案对比

| 方案 | 体积 | 效果 | 环境冲突 | 可行性 |
|---|---|---|---|---|
| **① SBV2 + RikkaBotan** | 190MB + 依赖 ~3GB | ✅ 真萌系 | 需独立 venv (py3.12) | ⚠️ 依赖 pyannote 等重包 |
| ② sherpa-onnx + melo-tts | 170MB | ⚠️ 普通女声，不萌 | ✅ 无冲突（纯 onnx） | ✅ 最稳 |
| ③ Windows SAPI | 0 | ❌ 机械感明显 | ✅ 无 | ✅ 已验证 |
| ④ GPT-SoVITS 整合包 | 3~5GB | ✅ 好，可换音色 | ✅ 自带环境 | ✅ 但下载慢 |

---

## 四、我的建议：分两步走

### 第 1 步：先用 sherpa-onnx 跑通链路（今天就能完成）

```
sherpa-onnx (纯 onnxruntime, 无 torch)
  + melo-tts-zh_en (170MB, 中英双语)
  → 合成 wav
  → NapCat 发语音
```

**为什么先用它**：
- **零环境冲突**（不装 torch，只用 onnxruntime）
- 下载只有 170MB
- 能验证「机器人说中文 + 发语音」这条完整链路
- 音色是普通女声，不萌，但**先跑通**

### 第 2 步：换 RikkaBotan 萌系音色（环境就绪后）

```
Python 3.12 venv
  + Style-Bert-VITS2
  + RikkaBotan 模型
  → 换掉 TTS 后端，其他代码不动
```

**接口设计成可替换**，换后端只是改一个配置。

---

## 五、第 1 步的详细计划

### 组件

| 组件 | 说明 |
|---|---|
| `sherpa-onnx` pip 包 | 纯 CPU/GPU onnx 推理，支持 NVIDIA CUDA |
| `vits-melo-tts-zh_en` | 中文+英文，model.onnx 170MB |
| 机器人触发词 | 「说一句xxx」/「用语音说xxx」 |
| NapCat record | 已验证可用 |

### 预计耗时

| 步骤 | 时间 |
|---|---|
| 装 sherpa-onnx | 2 分钟 |
| 下模型（170MB，走代理） | 2~3 分钟 |
| 写 TTS 客户端 | 30 分钟 |
| 接进 pipeline | 30 分钟 |
| 端到端验证 | 15 分钟 |
| **合计** | **约 1.5 小时** |

### 后续换音色成本

因为接口抽象了，换 RikkaBotan 只需：
1. 建 py3.12 venv，装 SBV2
2. 写一个 `Sbv2Client` 实现同样的接口
3. 改配置指向它

**机器人代码不用动。**

---

## 六、sherpa-onnx 的能力确认

| 项 | 情况 |
|---|---|
| 语言 | 中文 + 英文（melo-tts-zh_en） |
| 需要 GPU 吗 | 可选，CPU 也能跑（慢些） |
| 显存占用 | 约 500MB（如果用 CUDA）或 0（CPU） |
| 速度 | CPU 约实时 1/5， GPU 约实时 3~5 倍 |

**先不占 GPU**，用 CPU 跑，这样不跟 ComfyUI 抢显存。

---

## 七、要你确认

1. **同意「先 sherpa-onnx 跑通，再换 RikkaBotan」吗？**
   这是最稳妥的路径，今天就能看到效果。

2. **触发词怎么定？**
   - `说一句xxx`
   - `用语音说xxx`
   - `念一下xxx`
   - 或者你有别的想法

3. **默认用 CPU 还是 GPU？**
   建议 CPU（不抢 ComfyUI 显存），速度稍慢但够用。

4. **要不要顺便做「语音念白」和「唱歌」分开？**
   念白先用这个方案，唱歌以后走 SVC。

---

## 八、风险与备选

### 如果 sherpa-onnx 的中文效果很差

备选：Windows SAPI 的 Yaoyao/Huihui（已验证能发声，机械感但能懂）。

### 如果一定要萌系又不想折腾环境

备选：**直接用 GPT-SoVITS 整合包**（自带完整环境，3~5GB）。
它本来就要装，而且以后唱歌也要它。

**这条路其实更直接**——一次装好，念白和唱歌都能用。

---

## 九、我的最终建议

看你耐心程度：

| 你的偏好 | 推荐 |
|---|---|
| **想快点看到效果** | sherpa-onnx（1.5 小时） |
| **想要萌系一次到位** | GPT-SoVITS 整合包（下载 3~5GB，可能 1 小时）+ RikkaBotan 模型 |
| **不想折腾环境** | 先用 Windows SAPI 接进机器人（30 分钟），以后再换 |

告诉我选哪个，我直接开干。

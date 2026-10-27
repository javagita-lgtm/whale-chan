# 唱歌功能：SVC 技术验证完成

完成时间：2026-10-24

---

## 一、结果：跑通了

用 **SoulX-Singer-SVC** 成功把一首 4 分 02 秒的歌换成了爱音的音色。

```
SoulX demo（官方音色）→ 65.9 秒
爱音音色翻唱        → 133.2 秒
输出：4分02秒 / 24kHz / mono wav
```

**已发到群里两条**：
1. 官方 demo 翻唱（前 60 秒）
2. 爱音音色翻唱（前 45 秒）

---

## 二、环境搭建踩的坑（五个）

### 1. torch 版本三家不合

| 环境 | Python | torch | 用途 |
|---|---|---|---|
| ComfyUI venv | 3.13 | 2.11 | 生图 |
| tts-venv | 3.12 | 2.3.1 CPU | SBV2 说话 |
| **svc-venv（新建）** | 3.12 | **2.3.1 CUDA** | 唱歌 |

**为什么必须再建一个**：SBV2 用 CPU 版 torch 就够，
但 SoulX SVC 要 CUDA 加速（CPU 版跑 4 分钟的歌要几小时）。

### 2. pytorch 官方源下载 2.4GB 会卡死

实测 pip 装 `torch==2.3.1+cu121` 时会停在某个百分比不动。

**解决**：`curl -C - --retry 3` 断点续传，14 分钟下完 2.26GB，再本地安装。

### 3. `--no-deps` 装 torch 缺 mkl

```
OSError: [WinError 126] Error loading "torch\lib\shm.dll"
```

torch 的 Windows 版依赖 `mkl<=2021.4.0`，`--no-deps` 跳过了。

**解决**：补装 `mkl` + `intel-openmp`。

### 4. 装依赖时 torch 被静默升级

装 `accelerate` 时，pip 把 `torch 2.3.1+cu121` 升成了 `2.14.1+cpu`，
**CUDA 支持直接消失**。

**解决**：每次装完依赖后检查 `torch.cuda.is_available()`，
用 `--force-reinstall --no-deps` 装回 wheel。

### 5. numpy / librosa / scipy 版本连锁

SoulX 要求 `numpy<2.0`，但新版 librosa 要求 `numpy>=2.1`。

**解决**：
```
numpy==1.26.4
librosa==0.10.2
scipy==1.13.1
```

---

## 三、SVC 需要什么输入

```
prompt_wav   + prompt_f0.npy     ← 音色参考（谁的声音）
target_wav   + target_f0.npy     ← 目标歌曲（唱什么旋律）
```

**关键：F0 要单独提取**，不是模型内部算的。

用 `preprocess/tools/f0_extraction.py` 的 `F0Extractor`：

```python
ex = F0Extractor(
    model_path='rmvpe.pt',
    device='cuda',
    input_sr=16000,
    target_sr=24000,
    hop_size=480,
)
ex.process(audio_path, f0_path='xxx_f0.npy')
```

RMVPE 权重（173MB）从 `Soul-AILab/SoulX-Singer-Preprocess` 下的。

---

## 四、实测性能

| 项目 | 数据 |
|---|---|
| 4 分 02 秒歌曲，官方音色 | **65.9 秒** |
| 4 分 02 秒歌曲，爱音音色 | **133.2 秒** |
| 推理速度 | 约 **2 秒音频 / 秒** |
| 分段数 | 12 段 |
| 每段耗时 | 8.5~9.8 秒 |

**爱音那趟更慢**，因为 `--auto_shift` 要做音高对齐（爱音音域和目标原唱不同）。

---

## 五、显存与磁盘

| 项目 | 占用 |
|---|---|
| SVC 推理显存 | 约 4~5 GB（fp16） |
| SoulX 代码 + 模型 | **2.82 GB** |
| svc-venv | **5.46 GB** |
| E 盘剩余 | 421 GB |

**注意**：SVC 和 ComfyUI 生图同时跑会 OOM（8GB）。
需要串行或做显存调度。

---

## 六、关键限制

### 1. 必须有「原曲人声」

SVC 是**音频→音频**，不能从歌词生成。
所以要么用户提供音频，要么我们准备曲库。

### 2. 长歌耗时长

| 歌曲长度 | 推理耗时 |
|---|---|
| 1 分钟 | ~2 分钟 |
| 4 分钟 | ~2 分钟（爱音 133 秒） |
| 5 分钟 | ~2.5 分钟 |

群里等 2 分钟体验很差，需要异步通知。

### 3. 版权

翻唱现有歌曲涉及著作权。**群里传播有风险**。

---

## 七、目录结构

```
E:\SoulX-Singer\
  ├── SoulX-Singer-main\          （代码，12.4 MB）
  │   ├── cli\inference_svc.py    （SVC 推理入口）
  │   ├── soulxsinger\config\soulxsinger.yaml
  │   ├── preprocess\tools\f0_extraction.py
  │   └── example\audio\          （测试素材）
  ├── pretrained_models\
  │   ├── SoulX-Singer\model-svc.pt   （2.60 GB）
  │   └── rmvpe.pt                    （173 MB）
  ├── f0\                         （提取的 F0）
  └── output\anon-cover\generated.wav

E:\svc-venv\                      （Python 3.12 + torch 2.3.1 CUDA）

E:\PRO\etc\daliy\whale-chan\scripts\extract_f0.py   （F0 提取封装）
```

---

## 八、下一步：接入机器人

技术已通，剩下的是工程问题。需要解决：

| 问题 | 方案 |
|---|---|
| 歌从哪来 | ① 用户发音频 ② 预置曲库 |
| 人声/伴奏分离 | 用 GPT-SoVITS 自带的 UVR5（已装，46 秒处理 4 分钟） |
| 混音 | ffmpeg 合成 |
| 2 分钟等待 | 先回"在唱了"，完成后发 |
| 显存冲突 | 与 ComfyUI 排队 |

### 建议流程

```
用户：唱首《XXX》
  → 检查曲库 / 要求上传
  → UVR5 分离人声
  → 提取 F0
  → SVC 换音色
  → 混音（原伴奏 + 新的人声）
  → 发语音
```

---

## 九、要你定

1. **曲库策略**
   - A. 用户发音频（最安全）
   - B. 预置 3~5 首（需要素材，有版权风险）
   - C. 只保留技术能力，不接机器人

2. **等 2 分钟能接受吗？**
   建议：先回"在唱了，稍等"，异步发送。

3. **要不要限制时长？**
   比如只做 60 秒片段（耗时约 2 分钟，可以接受）。

4. **音质反馈**
   刚发的两条你听了吗？效果满意吗？
   如果不满意，可能需要调 `--pitch_shift` 或换参考音频。

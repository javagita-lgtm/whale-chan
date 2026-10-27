# MYGO 微调模型接入

完成时间：2026-10-24

---

## 一、你给的资源比我找到的好得多

`E:\PRO\etc\daliy\whale-chan\voicemodel` 里是**完整训练过的 GPT-SoVITS 模型**，
不是我之前从 B 站视频提取的零样本参考音频。

| 项目 | 我从 B 站提取的 | 你给的这套 |
|---|---|---|
| 类型 | 零样本克隆 | **微调训练模型** |
| 覆盖 | 爱音 + 素世（推测） | **6 个角色，全部确认** |
| 质量 | 一般 | **高** |
| 参考音频 | 4~5 秒单句 | 每个角色几百个干声素材 |

### 模型清单

| 角色 | GPT 权重 | SoVITS 权重 | 干声素材 |
|---|---|---|---|
| **anon（爱音）** | anon1-e15.ckpt | anon1_e8_s2184.pth | 835 个 |
| **soyo（素世）** | soyo1-e20.ckpt | soyo1_e12_s1428.pth | 295 个 |
| **tomori（灯）** | tomori1-e20.ckpt | tomori1_e12_s2664.pth | 13 个 |
| **taki（立希）** | riki1-e15.ckpt | riki1_e8_s3128.pth | 801 个 |
| **rana（乐奈）** | rana1-e20.ckpt | rana1_e12_s1176.pth | 201 个 |
| **sakiko（祥子）** | sakiko1-e15.ckpt | sakiko1_e8_s560.pth | 156 个 |

**总共 0 GB 占用**（目录本身很小，干声是分散的小文件）——实际约 1.4 GB。

---

## 二、结果：7 个音色全部可用

```
音色列表（7 个，当前 anon）:
  anon     finetuned  anon
  soyo     finetuned  soyo
  tomori   finetuned  tomori
  taki     finetuned  taki
  rana     finetuned  rana
  sakiko   finetuned  sakiko
  rikka    zero-shot  RikkaBotan 中文萌系（GSV）
```

**我已经把 6 个角色的语音都发到群里了**，你可以逐个试听。

### 实测性能

| 音色 | 类型 | 合成"我是XXX"耗时 |
|---|---|---|
| anon | 微调 | 5.8s |
| soyo | 微调 | 5.6s |
| tomori | 微调 | 4.7s |
| taki | 微调 | 5.2s |
| rana | 微调 | 4.6s |
| sakiko | 微调 | 5.1s |
| rikka | 零样本 | 1.4s |

微调模型慢一些，因为每次切换权重（set_gpt_weights + set_sovits_weights）要 1~3 秒。
**连续用同一角色时不会重复切换**（有缓存）。

---

## 三、技术实现

### 关键发现：微调模型仍然需要参考音频

即使模型已经在该角色声音上训练过，**推理时仍需一段参考音频**来定音高/语调/情感。
区别在于：微调模型的音色来自权重，参考音频只提供"这一句怎么念"。

我从每个角色的干声素材里自动挑了 **3~10 秒的语义片段**（有日文文件名的，不是自动切的）：

| 角色 | 参考音频 | 时长 |
|---|---|---|
| anon | そよさんは？駄目て、ぜんぜん意味わからないけと | 5.02s |
| soyo | ちょ、ちょっと待って!どうして何かあった | 5.00s |
| tomori | これからもずっと何も考えないで歌えた | 4.98s |
| taki | 早く決めないとライブに間に合わなくなる素人のアノンじゃ | 5.09s |
| rana | ん準備できた。ライブまだライブやりたい | 5.09s |
| sakiko | え私の勘違いでしたの | 4.90s |

### 三个关键接口

GPT-SoVITS 原生 API 支持动态切权重：

```
GET /set_gpt_weights?weights_path=GPT_weights/anon1-e15.ckpt
GET /set_sovits_weights?weights_path=SoVITS_weights/anon1_e8_s2184.pth
```

适配层 `gsv_server.py` 里做了缓存：

```python
_loaded = {'gpt': ..., 'sovits': ...}

def ensure_weights(v):
    if gpt and _loaded.get('gpt') != gpt:
        gsv_get('/set_gpt_weights', {...})
        _loaded['gpt'] = gpt
    # sovits 同理
```

**同一角色连续请求不重复切换**，省 1~3 秒。

### 踩的坑

**1. 中文路径 GPT-SoVITS 找不到文件**

```
Exception: E:\...\参考音频\Anon干声素材\待って待って....wav not exists
```

文件明明存在。**GPT-SoVITS 对中文/日文路径处理有 bug**。

修复：把参考音频复制到纯 ASCII 路径 `E:\GPT-SoVITS\ref\mygo\`。

**2. 权重必须放在 GPT-SoVITS 自己的目录下**

`set_*_weights` 接口只接受相对路径（相对于 GPT-SoVITS 根目录），
不能传绝对路径。所以要先 `shutil.copy2` 到：
```
E:\GPT-SoVITS\GPT-SoVITS-v4-20250422fix\GPT_weights\
E:\GPT-SoVITS\GPT-SoVITS-v4-20250422fix\SoVITS_weights\
```

**3. 控制面板探测的端口没改**

`control-api.ts` 里还写着 `probePort(5050)`，但实际后端在 5051。
导致面板显示「TTS 未启动」。

**4. 面板进程是旧的**

改了 `control-api.ts` 但没重启面板进程，`/api/voices` 仍然 404。

---

## 四、控制面板

打开 http://127.0.0.1:8787 ：

```
语音服务
● 就绪
7 个音色 · 当前 anon

语音音色
┌──────────────────────────────────┐
│ anon                        [使用中] │
│ anon · ja · anon-ref.wav          │
├──────────────────────────────────┤
│ soyo                                │
│ soyo · ja · soyo-ref.wav            │
└──────────────────────────────────┘
```

点击即切换，切换时加载权重（1~3 秒）。

---

## 五、文件清单

| 文件 | 说明 |
|---|---|
| `voicemodel/` | 你提供的模型和干声素材（约 1.4 GB） |
| `scripts/setup_mygo.py` | 一键配置：复制权重 + 挑参考音频 + 验证 |
| `scripts/gsv_server.py` | 重写：支持微调模型 + 权重缓存 |
| `E:\GPT-SoVITS\ref\mygo\` | 复制出来的参考音频（ASCII 路径） |
| `E:\GPT-SoVITS\ref\mygo\mygo-voices.json` | 音色配置清单 |
| `E:\GPT-SoVITS\GPT_weights\*.ckpt` | 复制进去的 GPT 权重 |
| `E:\GPT-SoVITS\SoVITS_weights\*.pth` | 复制进去的 SoVITS 权重 |

---

## 六、磁盘

| 项目 | 大小 |
|---|---|
| GPT-SoVITS 整合包 | 7.01 GB |
| voicemodel（你给的） | 约 1.4 GB |
| E 盘剩余 | **433 GB** |

---

## 七、现在怎么用

1. **打开 http://127.0.0.1:8787**
2. 在「语音音色」里点一个角色
3. 群里发「说一句你好呀」

机器人会用选中的音色说话。

---

## 八、还能做什么

| 功能 | 说明 |
|---|---|
| **唱歌** | GPT-SoVITS 只管说话；唱歌要 SVC（拿原曲换音色） |
| **情绪控制** | 参考音频的情感会带到输出，换不同素材能换语气 |
| **多角色对话** | 可以让不同角色轮流说（需要脚本编排） |
| **日语/中文混说** | 已支持，`text_lang` 可切 |

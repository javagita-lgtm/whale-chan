# NoobAI-XL 接入完成

完成时间：2026-10-23

---

## 一、效果对比

同一个需求「生成一张接近原版风格的 saber 图」：

| 模型 | 画风 | 角色还原 | 耗时（768/832） |
|---|---|---|---|
| `dreamshaper_8`（旧） | 3D 写实 CG 质感 | 特征对但像真人 Cosplay | **13 秒** |
| `NoobAI-XL`（新） | **纯日系动漫** | **金发绿眼呆毛蓝白裙全对** | **25~33 秒** |

换成 NoobAI 后，金发、绿眼、呆毛、盘发蓝丝带、蓝白裙、胸甲纹样全部准确，
这就是 saber 的标准形象。

---

## 二、踩坑：v-pred 参数不对会出纯色块

第一次用 NoobAI 出图，结果是一张**纯黄色剪影**（有轮廓没细节）。

原因：**NoobAI-XL 的 Vpred 版本是 v-prediction 模型**，
必须在采样前插入 `ModelSamplingDiscrete` 节点并设 `sampling: v_prediction`。

```json
{
  "10": {
    "class_type": "ModelSamplingDiscrete",
    "inputs": {
      "model": ["4", 0],
      "sampling": "v_prediction",
      "zsnr": false
    }
  }
}
```

同时 KSampler 的 `model` 输入要指向节点 10 而不是节点 4。

**不加这个节点**：出纯色块（v-pred 的预测目标是 velocity 不是 noise，
当成 eps 模型用会直接崩掉）。

---

## 三、参数调优（实测四组）

| 组合 | CFG | 采样器 | 调度器 | 结果 |
|---|---|---|---|---|
| A | 4.0 | euler | normal | ✅ 好，色彩自然 |
| **B** | **5.0** | **euler** | **normal** | ✅ **最佳** |
| C | 4.5 | euler_ancestral | normal | ❌ 过饱和，金发变橙红 |
| D | 3.5 | euler | sgm_uniform | ✅ 好但偏亮，对比度弱 |

**最终选定 B：cfg=5, euler, normal, 28 步**

关键经验：
- **v-pred 不能用 karras 调度器**（会出纯色块）
- **CFG 要低**（4~5），高了色彩过饱和
- **不要用 euler_ancestral**（噪声注入导致偏色）

---

## 四、双模型策略

现在两个模型并存，按场景自动选：

| 条件 | 模型 | 尺寸 | 耗时 |
|---|---|---|---|
| 群聊日常「画个猫」 | SD1.5 `dreamshaper_8` | 512 | ~10 秒 |
| 点名角色「saber (fate)」 | SDXL `NoobAI-XL` | 832 | ~25~33 秒 |
| 要求「高清/大图」 | SDXL | 832 | ~25~33 秒 |
| 私聊（默认质量优先） | SDXL | 832 | ~25~33 秒 |
| 中文「XX的图/立绘」 | SDXL | 832 | ~25~33 秒 |

代码在 `pickPreset()`：

```ts
const wantsQuality = /(高清|大图|高分辨率|精细|高质量|原版|official|1024)/.test(text);
const hasCharacter =
  /[a-zA-Z][a-zA-Z\s]{2,}\s*\(/.test(text) || /(的图|立绘|角色图)/.test(text);

if (wantsQuality || hasCharacter) return MODEL_PRESETS.sdxl_anime;
if (isPrivate) return MODEL_PRESETS.sdxl_anime;
return MODEL_PRESETS.sd15;
```

---

## 五、下载：6.62GB 怎么下来的

HuggingFace 直连只有 **0.09 MB/s**，6.62GB 要 20 小时。

### 关键发现：本机有 xray 代理

```
D:\v2rayN-windows-64\bin\xray\xray.exe
监听 127.0.0.1:10808
```

走代理后 **1~2.4 MB/s**，快了 11~26 倍。

### 8 分片并发

`scripts/download-model.ps1`：

```powershell
curl.exe -L -s --max-time 7200 -x socks5h://127.0.0.1:10808 \
  -r "$start-$end" -o "$partFile" "$Url"
```

每个分片 847MB，并行下载后按顺序拼接。

### 踩的两个坑

**1. `Start-Job` 里的 curl 拿不到代理参数**

第一次用 `Start-Job` 并行，所有分片都是 **0 字节**。
改成 `Start-Process` 直接起 curl 才正常。

**2. 部分分片中途退出**

下到 70% 时只剩 1 个进程，3 个分片不完整（part1/3/7）。
写 `resume-download.ps1` 从断点续传。

**3. 最后一个分片特别慢**

part7 只有 0.11 MB/s，预计还要 107 分钟。
把它**再拆成 4 个子段并行**，2 分钟就下完了（每段 2.36 MB/s）。

这个技巧值得记：**分片不够细的时候，继续细分**。

---

## 六、磁盘变化

| 项 | 大小 |
|---|---|
| 下载的模型 | 6.62 GB |
| 下载临时分片 | 已清理 |
| 剩余空间 | E 盘 484GB → 477GB |

**`v1-5-pruned-emaonly`（2GB）还在**，它是 SD1.5 官方原版，
画风不如 dreamshaper_8，纯占空间。要删的话说一声。

---

## 七、代码变更

| 文件 | 改动 |
|---|---|
| `src/core/comfy.ts` | 新增 `vPred` 选项 + `ModelSamplingDiscrete` 节点 |
| `src/core/image-gen.ts` | 新增 `MODEL_PRESETS`、`pickPreset`、`resolveSizeForPreset` |
| `src/core/prompt-translate.ts` | 新增画风识别与风格词 |
| `test/model-preset.test.ts` | 16 个单测 |
| `test/prompt-translate.test.ts` | 14 个单测 |
| `scripts/download-model.ps1` | 8 分片并发下载 |

全量测试：**252 个**，全部通过。

---

## 八、怎么用

| 你说 | 用的模型 | 耗时 |
|---|---|---|
| 画个猫 | SD1.5 | ~10 秒 |
| 画个高清猫 | SDXL | ~25 秒 |
| saber (fate) | SDXL | ~25 秒 |
| 生成一张saber的图（私聊） | SDXL | ~25 秒 |

**建议**：点名要角色时，用 `角色名 (作品名)` 的写法，识别最准。
比如 `furina (genshin impact)`、`hatsune miku`。

# MYGO 音色接入

完成时间：2026-10-24

---

## 一、结果：爱音和素世都有了

```
可用音色（3 个）:
  anon   | 千早爱音（MYGO）        | 日语
  soyo   | 长崎素世（MYGO）        | 日语
  rikka  | RikkaBotan 中文萌系（GSV）| 中文
```

**我已经把三条语音发到群里了**，你听听像不像：
- 爱音版：「你好呀，我是千早爱音，今天天气真不错呢！」
- 素世版：「你好呀，我是长崎素世。今天天气还不错。」
- （之前还有 RikkaBotan 的中文萌系）

**⚠️ 但有个前提要说清楚**：角色归属是我推断的，不是官方确认。理由见第四节。

---

## 二、素材来源

### 尝试过的路，都不通

| 途径 | 结果 |
|---|---|
| HuggingFace 搜 MYGO 语音模型 | ❌ 全是画图 LoRA，没有语音 |
| 百度网盘（渐展工作室 V4） | ❌ 需要登录 |
| 夸克网盘（花咲川楽奈 v2ProPlus） | ❌ 需要登录 |
| B 站分享的 GPT-SoVITS 模型 | ❌ 格式是 `.pth`（GSV 训练模型），

但我们只需要"参考音频"，不需要模型本体

### 最终走的路：从 B 站视频提取

```
1. 找素材视频
   BV1JHgSzmEx6  【官粮｜爱素】MyGO!!!!!ZEPP TOUR 2025 东京限定语音
   4 分 02 秒，官方语音，爱音和素世双人对话

2. 下载音频
   yt-dlp（装到 E:\tts-venv）
   4.23 MB，m4a → wav

3. 分离人声
   GPT-SoVITS 自带的 UVR5（bs_roformer 模型）
   耗时 46 秒，输出 40.6 MB 纯净人声

4. 切分候选片段
   ffmpeg silencedetect（-30dB, 0.4 秒）
   找到 12 个 3~10 秒的连续语音段

5. 识别文本
   faster-whisper small（CPU，int8）
   日语识别，输出 12 句台词
```

### 提取的 12 句台词

```
seg0  リハが終わったから飲み物買いに行くって出てきたんだよね
seg1  それだったら、私も行こうかなって言ったよね
seg2  わざわざこんなところまで来る必要ないんじゃないかって言ってるの
seg3  えぇー?せっかくお台場まで来たのにもったいないじゃん
seg4  ちょっとくらいもだいばって感じのもの見て帰ろうよ
seg5  それはライブの後、他の国に付き合ってもらえばいいと思うな
seg6  おダイバーって他にも見るものないのかなぁ
seg7  お台場、夜景行って検索
seg8  最終便 最終便
seg9  だめだ、ライブ終わりじゃ間に合わなさそう
seg10 内部終わり、夜景迷子みたいな写真撮ったら眠くない?
seg11 とりあえず、レインボーブリッジの写真も撮っておこうと
```

---

## 三、为什么这两句是这些角色

### 台词气质分析

| 台词 | 语气 | 判断 |
|---|---|---|
| seg3「せっかくお台場まで来たのにもったいないじゃん」 | 活泼、不愿浪费、爱提议 | **爱音** |
| seg2「わざわざこんなところまで来る必要ないんじゃないか」 | 冷淡、理性、泼冷水 | **素世** |

### F0（基频）佐证

| 片段 | F0 均值 | 说明 |
|---|---|---|
| seg3（爱音） | **372 Hz** | 全场最高，符合活泼少女 |
| seg0 | 320 Hz | |
| seg2（素世） | **288 Hz** | 偏低，符合冷淡沉稳 |

音高差异明显，和角色性格一致。

### ⚠️ 我必须说明的不确定性

**我没有 100% 的证据确认这两句分别是谁说的。**

理由：
1. B 站这个视频**没有字幕**（查过 `/x/player/v2` 接口，0 个字幕）
2. 视频简介里只说「爱素」，没说哪句是谁
3. 我用 MFCC 聚类试过，但组0 有 10 句、组1 只有 3 句且都是短句，**聚类不可靠**
4. 判断主要靠「台词气质 + 音高」推断

**所以：如果听着不像，告诉我，我换片段重试。**

---

## 四、技术细节

### 参考音频要求（GPT-SoVITS 硬限制）

实测发现的限制：

```
参考音频必须 3~10 秒
超出直接报错：参考音频在3~10秒范围外，请更换！
```

而且 **prompt_text 必须和音频内容一字不差**，否则音素对不齐，合成质量崩坏。

所以流程必须是：
```
音频 → 切分 → ASR 识别 → 人工核对 → 写进配置
```

### 踩的坑

**1. UVR5 的模块导入路径**

`bsroformer.py` 里是 `from bs_roformer.bs_roformer import BSRoformer`（顶层导入），
但包在 `tools/uvr5/bs_roformer/`。必须：

```python
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / 'tools' / 'uvr5'))   # ← 关键
```

**2. faster-whisper 缺 cublas**

```
RuntimeError: Library cublas64_12.dll is not found
```

VideoTranscribe 的 venv 里 CUDA 运行库不全，改 CPU `int8` 即可。

**3. PowerShell 控制台中文乱码**

ASR 输出显示成乱码，其实是**控制台 GBK 编码**问题，不是识别错误。
解决：`sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')` 写文件再读。

**4. JSON 配置的 BOM**

`Set-Content -Encoding UTF8` 会写 BOM，Python `json.loads` 报错。
用 `[Text.UTF8Encoding]::new($false)`。

---

## 五、音色配置格式

```
E:\GPT-SoVITS\ref\
  ├── anon.json
  │   {
  │     "name": "千早爱音（MYGO）",
  │     "audio": "anon.wav",
  │     "text": "えぇー?せっかくお台場まで来たのにもったいないじゃん",
  │     "lang": "ja"
  │   }
  ├── anon.wav      (3.61 秒)
  ├── soyo.json
  ├── soyo.wav      (4.14 秒)
  ├── rikka.json
  └── rikka-ref8s.wav
```

GSV 适配层自动扫描 `*.json`，控制面板的音色列表会自动更新。

### 加新角色

只要三样：
1. **3~10 秒的干净人声**（无背景音乐）
2. **准确的文本转录**
3. 一份 JSON

---

## 六、实测性能

| 音色 | 文本 | 音频时长 | 合成耗时 |
|---|---|---|---|
| anon | 20 字 | 2.84s | **3.6s** |
| soyo | 17 字 | 3.48s | **5.8s** |

比 SBV2 快（SBV2 合成 3.5 秒要 2.5 秒，但长文本明显更慢）。

---

## 七、语言支持

GPT-SoVITS 原生支持：
- 中文 `zh`
- 英文 `en`
- **日语 `ja`** ← MYGO 用这个
- 韩语 `ko`
- 粤语 `yue`

**跨语言也能用**：用日语参考音频说中文，也试过（`anon-test.wav`），效果尚可。

---

## 八、文件清单

| 文件 | 说明 |
|---|---|
| `E:\GPT-SoVITS\raw\zz-tour.wav` | 原始音频（4 分 02 秒） |
| `E:\GPT-SoVITS\sep\zz-tour\zz-tour_vocals.wav` | UVR5 分离的人声（40.6 MB） |
| `E:\GPT-SoVITS\sep\segments.txt` | 12 个候选片段时间表 |
| `E:\GPT-SoVITS\ref\all\seg*.wav` | 12 个切好的片段 |
| `E:\GPT-SoVITS\ref\anon.wav` + `.json` | 爱音参考音频 |
| `E:\GPT-SoVITS\ref\soyo.wav` + `.json` | 素世参考音频 |
| `scripts/gsv_server.py` | GSV 适配层（已自动发现新音色） |

---

## 九、下一步

| 选项 | 说明 |
|---|---|
| **听感反馈** | 如果不像，我换 `seg0/seg4/seg11` 等其他片段重试 |
| **找更好的素材** | 单独的爱音/素世语音集（避免双人对话混淆） |
| **唱歌** | GPT-SoVITS 只管说话，唱歌还要 SVC |
| **控制面板后端切换** | 现在 SBV2/GSV 要改 .env，可以做成面板点选 |

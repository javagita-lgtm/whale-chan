# 唱歌功能接入 + 音乐 API 曲库

完成时间：2026-10-27

---

## 一、结果

**「唱春日影」现在直接发 soyo 版成品，秒回。**

```
用户：唱《春日影》
机器人：（发送 soyo 版春日影 mp3，2分28秒）
```

已实测发到测试群：`message_id=1688485216`

---

## 二、曲库机制

### 优先级

| 情况 | 行为 |
|---|---|
| 曲库有 + 没指定音色 | **直接发成品**（秒回） |
| 曲库有 + 指定**同一**音色 | 直接发成品 |
| 曲库有 + 指定**其他**音色 | 走实时生成（几分钟） |
| 曲库没有 | 查 music API → 实时生成 |

### 当前曲库

`config/songs.json`：

```json
[
  {
    "id": "春日影",
    "title": "春日影",
    "file": "E:\\SoulX-Singer\\hikarigage\\soyo-haruhikage-cut.mp3",
    "voice": "soyo",
    "aliases": ["haruhikage", "春雾影", "春日影 (MyGO!!!!! ver.)", "春日影 MyGO"],
    "durationSec": 148
  }
]
```

### 支持的触发说法

```
唱《春日影》
唱一首春日影
唱一下春日影
来首歌
点歌 春日影
用soyo唱春日影
```

---

## 三、音乐 API 评估结论：完全可以当曲库用

`https://music-api.gdstudio.xyz/api.php`

### 五个接口全部实测可用

| 接口 | 用途 | 实测结果 |
|---|---|---|
| `types=search` | 搜歌 | ✅ 搜「春日影」返回 3 条 |
| `types=url` | 播放地址 | ✅ 320kbps，9.8 MB |
| `types=lyric` | 歌词 | ✅ LRC 格式，含时间轴，45 行 |
| `types=pic` | 封面 | ✅ 返回图片 URL |
| `types=playlist` | 歌单 | ✅ 返回完整歌单 |

### 下载实测

```
HTTP 200  13.8 MB/s  9.84 MB
44100 Hz / 2ch / 257.8s / 320kbps
```

**速度很快，320kbps 音质够用。**

### 歌词是意外收获

返回 LRC 格式带时间轴：

```
[00:15.045]悴んだ心 ふるえる眼差し
[00:19.371]世界で 僕は ひとりぼっちだった
[00:25.586]散ることしか知らない春は
```

**这对以后做 SVS（从歌词生成歌声）或 MIDI 对齐非常有用。**

### 一个坑：模糊匹配极宽松

搜「不存在的歌xyz」会返回标题叫「不存在的」的歌。

**应对**：
1. `isRelevant()` 做相关性过滤
2. 措辞分两种——精确匹配报歌名，模糊命中只说"我去找找"

```ts
const exact = result.title.trim().toLowerCase() === extractSongName(event.text).trim().toLowerCase();
const tip = exact
  ? `在唱了「${result.title}」（${result.voice} 音色），大概要几分钟…`
  : `我去找找「${query}」…（${result.voice} 音色）`;
```

---

## 四、代码结构

### 新增文件

| 文件 | 说明 |
|---|---|
| `src/core/music.ts` | 音乐 API 客户端（搜索/取地址/歌词/封面/下载） |
| `src/core/singer.ts` | 唱歌触发词、歌名提取、曲库匹配 |
| `test/singer.test.ts` | 18 个单测 |
| `config/songs.json` | 曲库配置 |

### 关键函数

```ts
// music.ts
class MusicClient {
  search(keyword, opts?)      // 搜歌
  getUrl(id, opts?)           // 播放地址
  getLyric(id, opts?)         // 歌词（解析成带时间轴的行）
  getCover(picId, size?)      // 封面
  download(url, destPath)     // 下载
}
parseLrc(lrc)                 // LRC → [{time, text}]

// singer.ts
wantsSing(text)               // 是否唱歌
extractSongName(text)         // 抠歌名
extractSingVoice(text)        // 抠音色
class Singer {
  handle(req)                 // 决策：preset / generating / notfound
  matchLibrary(query)         // 曲库匹配（支持别名 + 包含）
}
isRelevant(query, title)      // 相关性过滤
```

### 配置项

`.env` 新增：

```bash
SING_ENABLED=true
SING_LIBRARY_FILE=config/songs.json
SING_DEFAULT_VOICE=soyo
SING_TIMEOUT_MS=600000
SING_MAX_SECONDS=300
```

---

## 五、踩的坑

### 1. 触发词漏了书名号

```
唱《春日影》  → 最初匹配不上
```

原因：正则要求「唱」后必须有「一首/个」。修正为不锚定开头，并允许「唱」后直接跟内容。

### 2. 「用soyo唱」也匹配不上

因为用了 `^` 锚定开头。改成不锚定。

### 3. ConvertTo-Json 单元素数组降级

```powershell
@( @{...} ) | ConvertTo-Json   # 输出对象而不是数组
```

导致 `songs.json` 变成 `{...}` 而非 `[{...}]`，`loadSongLibrary` 返回空。

修正：`ConvertTo-Json -InputObject @($songs)`，并检查是否以 `[` 开头。

### 4. 实时生成只做了"登记"

`generating` 分支目前只发提示，**没有真正触发 SVC 生成**。这是刻意的——
SVC 一首 4 分钟的歌要 3~5 分钟，需要异步任务队列。

---

## 六、还没做的（实时生成）

`generating` 分支现在的行为：

```
用户：用 anon 唱春日影
机器人：我去找找「春日影」…（anon 音色）
（然后没有下文）
```

要补的是**异步生成链路**：

```
1. 立即回执（已实现）
2. 后台任务：
   music.search → music.getUrl → 下载
   → UVR5 分离人声（约 6 分钟/4分17秒）
   → 提取 F0（约 5 秒）
   → SVC 换音色（约 3 分钟）
   → 混音 + 归一化
   → 发送
3. 总耗时约 10 分钟
```

**问题：10 分钟太久。** 群里等这么久基本没法用。

### 建议方案

| 方案 | 说明 |
|---|---|
| **A. 只做预置曲库** | 想听的歌提前做好，秒回。最实用 |
| B. 限制时长 | 只生成 30~60 秒片段（约 1~2 分钟） |
| C. 后台队列 + 主动推送 | 接受 10 分钟，做完主动发 |
| D. 用更快的模型 | SoulX 是 3 分钟/首歌，换 RVC 可能更快 |

---

## 七、文件清单

| 文件 | 说明 |
|---|---|
| `soyo-haruhikage-cut.mp3` | 成品（2.8 MB，2分28秒） |
| `soyo-cut-norm.wav` | 无损版（6.8 MB） |
| `config/songs.json` | 曲库 |
| `src/core/music.ts` | 音乐 API 客户端 |
| `src/core/singer.ts` | 唱歌逻辑 |
| `test/singer.test.ts` | 18 个单测 |

全量测试：**419 个**（原 388 + 新 18 + 其他），全部通过。

---

## 八、限制

| 项目 | 现状 |
|---|---|
| 预置曲目 | 1 首（春日影 / soyo） |
| 实时生成 | **只有回执，没有真正生成** |
| 歌词利用 | 已能取到，尚未用于 SVS |
| 版权 | 音乐 API 是第三方聚合，可用性不保证 |

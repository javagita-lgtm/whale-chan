# Bili AI Summarizer 方案拆解 + 我们怎么"真看视频"

调研时间：2026-10-22
对象：[coztde/bili-ai-summarizer](https://github.com/coztde/bili-ai-summarizer)

---

## 一、它到底怎么做的

我读了它的源码（`src/pipeline/subtitle.ts`、`src/content/ai-subtitle.ts`、`src/pipeline/bilibili-audio.ts`、`src/provider/asr.ts`），逻辑如下：

```
【路径 1】字幕（主路径，零成本）
  ├─ 浏览器插件运行在 bilibili.com 页面里
  ├─ 拦截 performance.getEntriesByType("resource")
  │     → 里面记录了播放器加载过的字幕文件 URL
  ├─ 只认 aisubtitle.hdslb.com/bfs/ai_subtitle/
  ├─ 从 URL 文件名反解 aid + cid，校验与当前视频匹配
  └─ 用这个签名 URL 下载 JSON 字幕 → 纯文本

【路径 2】ASR（字幕不可用时，用户主动触发）
  ├─ playurl?fnval=16&qn=8 取 DASH 音轨
  ├─ 挑最低码率（覆盖更长）→ Range 探测大小
  ├─ 超 25MB 就放弃（ASR 上传限制）
  ├─ 下载 m4a → 直接传给 Groq / OpenAI 的 /audio/transcriptions
  └─ 拿到转录文本 → 总结
```

### 两个关键技术点

**1. 字幕 URL 是"搭便车"拿到的**

```ts
export function findLatestBilibiliSubtitleFromPage(): string | null {
  return findLatestBilibiliSubtitleUrl(
    performance.getEntriesByType("resource") as PerformanceResourceTiming[]
  );
}
```

它读的是**浏览器已经发出去的请求记录**。也就是说：

- 用户必须先在页面上播放视频
- 且手动在播放器里选「字幕 → 中文 AI」
- 播放器发起请求后，URL 才会出现在 performance 条目里
- 插件才能"捡到"这个签名地址

**这不是一个可以脱离浏览器调用的接口。**

**2. ASR 走云端，且限制 25MB**

```ts
export const ASR_FILE_UPLOAD_LIMIT_BYTES = 25_000_000;
groq:   { baseUrl: "https://api.groq.com/openai/v1",   model: "whisper-large-v3" }
openai: { baseUrl: "https://api.openai.com/v1",        model: "whisper-1" }
```

---

## 二、我们能不能直接用它？——不能，但能借鉴

### 不能直接用的原因

| 障碍 | 说明 |
|---|---|
| 它是浏览器插件 | 运行在 `bilibili.com` 页面沙箱里，我们是独立 Node 进程，拿不到 `performance` 条目 |
| 字幕要用户手动开 | 得在播放器里点「字幕 → 中文 AI」，机器人没法替用户点 |
| 需要浏览器登录态 | 插件天然有，我们没有 |
| ASR 要额外 Key | 它支持 Groq/OpenAI，我们没配；DeepSeek 不提供 ASR（实测 `/v1/audio/transcriptions` → 404） |

### 我实测的印证

```
未登录请求 x/player/v2 和 x/player/wbi/v2 → 全部失败
两个视频 need_login_subtitle=true、字幕数=0
```

即使之前有 `need_login_subtitle=false` 的视频，字幕数依然是 0。
说明**字幕轨道对匿名请求就是不返回的**，插件那条路必须有浏览器会话。

---

## 三、我们真正能做的：抽帧看画面

这是**唯一不依赖登录、不花钱、又能真看到画面**的方案。我已经实测跑通：

### 实测结果（106 秒视频）

```
1. 取 playurl → DASH 视频流
   480p H.264 852x480，0.83 MB

2. 直接下载（带 UA + Referer）
   成功，ffmpeg 识别：
   Duration: 00:01:45.27
   Video: h264 (High), 852x480, 30 fps

3. 抽帧
   ffmpeg -vf "fps=1/15,scale=640:-1"
   7 张，136 KB，耗时 1.2 秒

4. 多模态模型读图
   抽出的帧里能清楚看到：Linux 桌面、终端命令、
   底部水印文字「左下角的水印是 activate-linux，需要预先装好」
```

**注意第 4 步**：画面里的**文字是可读的**。这意味着对教程类、代码演示类视频，抽帧效果很好。

### 成本估算

| 视频时长 | 抽帧间隔 | 帧数 | 图片 token | 下载体积(480p) |
|---|---|---|---|---|
| 3 分钟 | 10 秒 | 18 | ~7k | ~1.5 MB |
| 10 分钟 | 30 秒 | 20 | ~8k | ~5 MB |
| 30 分钟 | 60 秒 | 30 | ~12k | ~15 MB |
| 60 分钟 | 120 秒 | 30 | ~12k | ~30 MB |

**耗时**：下载 1~10 秒 + 抽帧 1~3 秒 + 视觉理解 3~8 秒 ≈ **10~25 秒**。

比弹幕版慢，但能真看到画面。

---

## 四、三条路线的最终对比

| | 弹幕版（已上线） | 抽帧版 | ASR 版 |
|---|---|---|---|
| 需要登录 | ❌ 不需要 | ❌ 不需要 | ❌ 不需要 |
| 额外依赖 | 无 | ffmpeg（已有） | whisper + 模型 1~3GB |
| 额外费用 | 0 | 0（下载带宽） | ASR 按分钟计费 |
| 响应耗时 | **1~3 秒** | 10~25 秒 | CPU 下 视频时长×0.4 |
| 看到画面 | ❌ | ✅ | ❌ |
| 听到台词 | ❌ | ❌ | ✅ |
| 适用视频 | 热门/有梗 | 教程/演示/实拍 | 播客/讲座/访谈 |

**三者互补，不冲突。**
最理想是组合：弹幕给"观众反应"，抽帧给"画面"，ASR 给"台词"。

---

## 五、如果要做，我建议的顺序

### 第一步：抽帧（推荐，成本最低）

```
B 站链接
  ├─ 弹幕 + 评论（已有）
  ├─ 判断：视频 < 10 分钟 且 弹幕质量低
  │    └─ 触发抽帧：下载 480p → 每 N 秒抽一帧 → 送多模态
  └─ 合并成一个上下文块给模型
```

**为什么设"弹幕质量低"这个门槛**：热门视频弹幕信息量已经够了，没必要多花 15 秒和 10k token。只有弹幕稀疏（比如刚发布的教程）才值得抽帧。

### 第二步：ASR（可选，看你需求）

如果确实需要听懂讲座/访谈，可以接：
- **Groq**（免费额度大，`whisper-large-v3`，速度快）
- 或本地 `faster-whisper`（要装 1~3GB 模型，CPU 慢但零成本）

我实测过 25MB 限制：用最低码率 44kbps，**能覆盖 75 分钟**，够用。

---

## 六、需要你决定

1. **要不要做抽帧？** 我这边 ffmpeg 已有，实测跑通，大约 2~3 小时能上线。
2. **触发条件怎么定？**
   - A. 只有弹幕少于 N 条才抽帧（省资源）
   - B. 用户明确说"看看画面"才抽帧
   - C. 所有 B 站视频都抽（最全面但最慢）
3. **要不要接 ASR？** 如果要，你倾向 Groq（云端、快、免费额度）还是本地 whisper（零成本、慢、要下模型）？

我的建议是**先做 A**（弹幕少的才抽帧），这样热门视频还是秒回，只有冷门教程才多等 15 秒。

# Whale-chan 🐋

a ai robot

自研的 QQ / 微信群聊 AI 聊天机器人。核心只有一套内部消息模型，平台差异全部收敛在适配器里；
第一个适配器是 QQ（OneBot v11），微信适配器后续接入时不改业务层。

## 功能一览

| 类别 | 能力 |
|---|---|
| **对话** | 人设系统（可热重载、按群绑定）、长短记忆、字数分档（闲聊 120 / 技术 300 / 内容 600 / 详细 1500） |
| **主动插话** | 攒批判断该不该接话，带冷却 / 每小时上限 / 概率闸三重限流 |
| **内容理解** | 读网页、联网搜索、**B站视频**（弹幕 + 评论 + 抽帧 + 语音转写）、**小红书笔记** |
| **多模态** | 消息图 / 引用图 / 卡片封面，最多 2 张送视觉模型 |
| **消息增强** | 引用消息补全（get_msg 拉原文）、分享卡片解析（含封面图） |
| **生成** | 本地生图（ComfyUI，SD1.5 + SDXL 双模型 + 放大）、语音合成（TTS）、唱歌（SVC） |
| **表情包** | 1235 张图库，中文 n-gram 检索，模型自选 + 冷却控制 |
| **运维** | 守护进程（崩溃自启 + 崩溃循环检测）、开机免扫码、控制面板（4 页 138 项配置） |

## 目录结构

```
src/
  adapters/onebot/    OneBot v11 适配器（协议解析、段渲染、引用补全）
  core/
    pipeline.ts       消息管线主流程（248 行，只做编排）
    pipeline/         按职责拆分的功能模块
      context.ts        共享 deps 与可变状态
      enrichers.ts      链接 / 搜索 / B站 / 小红书
      speech.ts         唱歌 + TTS
      sticker-image.ts  生图 + 表情包
      interject.ts      主动插话
      images.ts         三路图片收集
      text.ts           串行队列 / 分片
    comfy.ts          ComfyUI 客户端
    image-gen.ts      生图触发与模型选择
    prompt-translate.ts  中文 → Danbooru tag
    web.ts            链接抓取 + 联网搜索
    xiaohongshu.ts    小红书解析
    bilibili.ts       B站 弹幕/评论
    media.ts          抽帧 + 语音转写
    singer.ts         唱歌（曲库 + SVC）
    tts.ts            语音合成
  web/                控制面板（HTML + API）
scripts/              启动、守护、迁移、审计工具
test/                 427 个测试用例
```

## 当前状态

- ✅ **QQ 适配层**：OneBot v11 正向 WebSocket 客户端，自动重连（指数退避 + 抖动）、echo 关联、CQ 码/数组双格式解析
- ✅ **业务骨架**：触发策略、幂等去重、防自激、按群串行队列、冷却限流
- ✅ **人设系统**：JSON 人设文件，支持多套人设 + 按群绑定 + 热重载
- ✅ **上下文记忆**：SQLite 持久化，按会话隔离，字符预算裁剪
- ✅ **模型接入**：OpenAI 兼容 Chat Completions，已在真实 DeepSeek API 上端到端验证通过
- ✅ **容错**：429/5xx/网络错误自动重试（指数退避 + 遵循 Retry-After）；推理模型 token 耗尽时给出可操作诊断
- ✅ **回复体验**：超长回复自动分片发送、可选打字延迟
- ✅ **表情包**：本地图库 + 中文 n-gram 检索；模型从真实候选里挑图，已实测发送成功
- ⏳ 微信适配器：尚未实现（见「路线图」）

## 快速开始

### 1. 安装依赖

```powershell
pnpm install
```

要求 Node.js ≥ 22.5（本项目使用内置 `node:sqlite`，实测 Node 24.16 通过）。

### 2. 配置

复制 `.env.example` 为 `.env`，至少填写：

```ini
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_API_KEY=sk-xxxxxxx
LLM_MODEL=deepseek-flash
ONEBOT_WS_URL=ws://127.0.0.1:3001
```

> ⚠️ `LLM_MODEL` 必须是服务商支持的**准确模型 ID**。DeepSeek 官方当前可用的是
> `deepseek-flash` 与 `deepseek-v4-pro`；填错（例如 `deepseek-v4.1-flash`）会直接返回 400。

### 3. 启动 NapCatQQ（QQ 协议端）

NapCat 是社区维护的 QQ 协议实现，基于 NTQQ 客户端，能把 QQ 消息转成 OneBot v11 协议。

1. 从 [NapCatQQ Releases](https://github.com/NapNeko/NapCatQQ/releases) 下载
   `NapCat.Shell.Windows.OneKey.zip`（一键包），解压后运行启动脚本；
2. 按提示扫码登录你的 QQ 小号；
3. 打开 NapCat 的 WebUI（默认 `http://127.0.0.1:6099`），进入 **网络配置**：
   - 新增 **WebSocket 服务器**（正向 WS）
   - 端口填 `3001`
   - **Token 留空**（或与 `.env` 里的 `ONEBOT_ACCESS_TOKEN` 保持一致）
   - 消息格式建议选 `array`
4. 保存并启用。

> 若 NapCat 不在本机，把 `ONEBOT_WS_URL` 改指向它的实际地址；跨机器时务必设置 Token。

### 4. 运行

```powershell
pnpm dev        # 开发模式（tsx watch 热重载）
pnpm build      # 编译到 dist/
pnpm start      # 运行编译产物
```

启动日志应依次出现：`记忆库已就绪` → `人设已加载` → `已连接 OneBot v11` → `登录身份确认`。

### 5. 在群里试一下

@ 机器人说一句话即可。默认 **群聊必须 @ 才回复**，私聊直接回复。

## 本地联调（不需要真实 QQ）

内置假 OneBot 服务端，可在完全不登录 QQ 的情况下验证整条链路：

```powershell
# 终端 1：启动假 OneBot（监听 3101）
pnpm config        # 打开配置界面
pnpm fake-onebot

# 终端 2：让机器人连到假服务
$env:ONEBOT_WS_URL='ws://127.0.0.1:3101'; pnpm dev
```

然后在终端 1 按回车，会推送一条 @ 机器人的群消息，终端 2 能看到完整处理日志。

## 配置项

| 变量 | 默认值 | 说明 |
|---|---|---|
| `LLM_BASE_URL` | `https://api.deepseek.com/v1` | OpenAI 兼容端点 |
| `LLM_API_KEY` | 空 | 为空则进入离线模式（只回显，不调模型） |
| `LLM_MODEL` | `deepseek-flash` | 模型 ID；DeepSeek 官方为 `deepseek-flash` / `deepseek-v4-pro` |
| `LLM_TIMEOUT_MS` | `60000` | 单次请求超时 |
| `LLM_TEMPERATURE` | `0.9` | 温度 |
| `LLM_MAX_TOKENS` | `512` | 回复最大 token（**推理模型建议 ≥1024**，否则思维链会吃光预算） |
| `LLM_MAX_RETRIES` | `2` | 可重试错误（429/5xx/网络）的最大重试次数 |
| `LLM_RETRY_BASE_DELAY_MS` | `800` | 重试基础退避，按 2^n 指数增长并叠加抖动 |
| `ONEBOT_WS_URL` | `ws://127.0.0.1:3001` | OneBot 正向 WS 地址 |
| `ONEBOT_ACCESS_TOKEN` | 空 | 与 NapCat Token 一致 |
| `BOT_SELF_ID` | 空 | 机器人 QQ；留空自动从事件学习 |
| `BOT_TYPING_DELAY_MAX_MS` | `0` | 回复前模拟打字延迟上限，0 关闭 |
| `BOT_MAX_MESSAGE_CHARS` | `1500` | 单条消息上限，超出自动分片发送 |
| `BOT_STICKER_RATE` | `1.0` | 模型选定表情包后的发送概率 |
| `BOT_STICKER_COOLDOWN_MS` | `180000` | 同会话两张表情包的最小间隔 |
| `TRIGGER_REQUIRE_AT_IN_GROUP` | `true` | 群聊必须 @ 才回 |
| `INTERJECT_ENABLED` | `false` | 主动插话总开关 |
| `TRIGGER_GROUP_COOLDOWN_MS` | `3000` | 同群最小回复间隔 |
| `CONTEXT_MAX_HISTORY_MESSAGES` | `20` | 带入上下文的最近消息条数 |
| `CONTEXT_HISTORY_WINDOW_MINUTES` | `120` | 上下文时间窗口 |
| `CONTEXT_MAX_CHARS` | `6000` | 上下文字符上限 |
| `DATA_DIR` | `data` | SQLite 存放目录 |
| `PERSONA_FILE` | `config/persona.json` | 人设文件 |
| `LOG_LEVEL` | `info` | 日志级别 |

## 配置界面

不想手改 `.env` 和人设 JSON，用浏览器改：

```powershell
pnpm config        # 打开 http://127.0.0.1:8787
```

界面分两个标签页：

| 标签 | 内容 |
|---|---|
| **参数配置** | 8 个分组、33 项配置，带类型校验、取值范围、默认值和说明 |
| **人设** | 可视化编辑人设（含 systemPrompt 文本框）、增删人设、按群绑定 |

### 安全设计

- **只监听 `127.0.0.1`**，外部机器无法访问，因此不需要密码。
- **密钥不回传**：`LLM_API_KEY`、`ONEBOT_ACCESS_TOKEN` 等字段前端只看到「已设置」占位，
  浏览器拿不到明文；留空保存表示不修改。
- **保存前校验**：类型错误（如把温度填成文字）、越界值（如 token 超出 256~8192）
  会被拒绝并提示具体字段，不会写进文件。
- **原子写**：先写临时文件再重命名，避免写一半中断导致 `.env` 损坏。
- **保序重写**：按 schema 分组顺序生成，杜绝历史上出现过的「注释和配置粘在一行」。

### 注意

- 参数配置保存后**需重启机器人**才生效（`.env` 是启动时读取的）。
- 人设保存后 **2 秒内自动生效**，不用重启。

## 人设

编辑 `config/persona.json`，支持多套人设与按群绑定：

```json
{
  "defaultPersonaId": "whale",
  "personas": [
    {
      "id": "whale",
      "name": "鲸鱼酱",
      "systemPrompt": "...",
      "replyMaxChars": 120,
      "replyTechMaxChars": 300
    }
  ],
  "groupBindings": { "123456789": "grumpy" }
}
```

**改完保存即生效**（每 2 秒检查文件 mtime），无需重启。解析失败会回落到内置兜底人设并打 warn 日志，不会拖垮进程。

### 字数上限按话题浮动

| 字段 | 作用 |
|---|---|
| `replyMaxChars` | **闲聊**时的字数上限，建议 80~150，保持短平快 |
| `replyTechMaxChars` | **技术话题**时的上限，默认 300，让原理类问题能讲清楚 |

判定方式是关键词匹配（`src/core/topic.ts`），覆盖编程语言、AI/大模型、排障表达、
请教句式等，**不额外调用模型**（零成本）。实测效果：

- 「今天吃啥好呢」→ 上限 120，回复 69 字
- 「docker 容器启动就退出，怎么看原因？」→ 上限 300，回复 224 字，
  讲清了 `docker ps -a` 查看退出码、`docker logs` 看输出、退出码 0 的含义

> `replyTechMaxChars` 低于 `replyMaxChars` 时以基础值为准，避免调大基础值后
> 反而在技术场景被截得更短。

## 表情包

### 建库

```powershell
pnpm stickers:fetch              # 全量抓取并入库
pnpm stickers:fetch --limit 50   # 只抓前 50 张试跑
```

数据来自 [梗鲸图库](https://aigengtu.com/DeepSeek娘) 的 DeepSeek娘表情包，
**仅供个人测试使用**。脚本会：

1. 解析列表页拿到编号 + 标题描述（标题就是检索语料）；
2. 下载原图，原图 404 时回退到预览图（站点并非每张都有原图）；
3. 用 sharp 统一转成 512px JPEG（QQ 对 WebP 兼容性不稳）；
4. 写入 SQLite 的 `stickers` 表与 `sticker_gram` 倒排索引表。

单次全量约 30 分钟；已下载的会跳过，可重复运行补全。

### 检索

```powershell
pnpm stickers:search 好累 -n 5
```

采用**中文 n-gram 倒排索引**（1~3 字连续片段），命中片段的长度越长权重越高：
单字 0.3、双字 1.0、三字 1.5，再除以查询总权重得到覆盖率。

> 为什么不用向量检索：本机实测 `onnxruntime` 创建会话会直接挂死（`cpu` / `dml` 后端都卡住，
> 连 JS 超时都不触发），在零运维前提下 n-gram 是最稳的落地方案。
> 代价是**纯语义相近但字面不重合的查询会漏召**，用内置的同义词表部分弥补
>（如「累」→ 死掉了 / 宕机 / 摆烂）。

### 发表情的完整链路

```
用户消息 → 检索出 8 个候选（按话题 + 随机补充）
        → 候选标题与编号一起写进提示词，让模型挑
        → 模型在回复末尾输出 <!--sticker: 029-->
        → 抽出编号并从正文剥离（不污染回复）
        → 概率闸 + 会话冷却（默认 3 分钟）→ 按 id 精确取图 → 发送
```

**关键设计**：让模型从**真实存在的编号**里挑，而不是自由描述情绪。
早期版本让模型自己描述「累到宕机」这类词，结果描述与图库标题对不上，命中率是 0。

### 相关配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `BOT_STICKER_RATE` | `1.0` | 模型给出编号后的发送概率；1 表示只要模型选了就发 |
| `BOT_STICKER_COOLDOWN_MS` | `180000` | 同会话两张表情包的最小间隔（3 分钟），防刷屏 |

### 踩过的坑

- **NapCat 的图片 `file` 字段必须是绝对路径**。传相对路径会返回 `retcode=1200`，
  且错误只出现在 stderr 日志里。适配器现在统一 `resolve()` 成绝对路径。
- 站点大量编号返回 404，需要预览图兜底，否则只能拿到约 10% 的图。

## 主动插话

让机器人**在没人 @ 它的时候**也能自己掺和一句。默认关闭。

### 为什么不是「每条消息掷骰子」

早期实现是给每条未 @ 的消息掷一次概率骰子（`TRIGGER_RANDOM_INTERJECT_RATE`）。
问题有两个：

1. **成本随消息量线性上涨**——群越活跃，调用越多，与"说话频率"脱钩；
2. **不像真人**——真人不会对每条消息都表态，而是听一会儿、觉得能接再接一句。

现在的做法是**攒一批再判断**：

```
未 @ 消息 → 只记录进缓冲（零 token）
          → 攒够 INTERJECT_MIN_MESSAGES 条，或首条距今超过 MAX_WAIT_MS
          → 一次轻量调用：把最近这批消息给模型，问「要不要接一句」
          → 模型回答 {"speak": true/false}（JSON，极小输出）
          → 要接 → 走正常回复流程；不接 → 丢弃这批，重置
```

### 成本估算

实测单次插话判断 + 生成回复 ≈ **1130 token**。假设一个活跃群每天 1500 条消息：

| 配置 | 日调用 | 月 token |
|---|---|---|
| `MIN_MESSAGES=20`（很省） | ~75 次 | ~2.5M |
| `MIN_MESSAGES=8`（默认） | ~187 次 | ~6.3M |
| `MIN_MESSAGES=3`（话痨） | ~500 次 | ~17M |

另有 `INTERJECT_COOLDOWN_MS`（默认 10 分钟）和 `INTERJECT_MAX_PER_HOUR`（默认 4 次）
硬性限流，所以实际调用次数会明显低于上表——上表是「不撞上限」时的理论峰值。

> 对比：如果只在被 @ 时回复，日 50 次 ≈ 56K token/天。插话确实会显著增加开支，
> 建议先用默认阈值跑几天，看实际账单再调。

### 开启方式

```ini
INTERJECT_ENABLED=true
INTERJECT_SCOPE=allowlist
INTERJECT_GROUPS=123456789,987654321   # 只在这些群插话
INTERJECT_MIN_MESSAGES=8
```

| 变量 | 默认 | 说明 |
|---|---|---|
| `INTERJECT_ENABLED` | `false` | 总开关 |
| `INTERJECT_SCOPE` | `allowlist` | `allowlist` 仅白名单群；`all` 所有群 |
| `INTERJECT_GROUPS` | 空 | 允许插话的群号，逗号分隔 |
| `INTERJECT_MIN_MESSAGES` | `8` | 攒够多少条判断一次（越大越省） |
| `INTERJECT_MAX_WAIT_MS` | `180000` | 首条最多等多久（3 分钟） |
| `INTERJECT_COOLDOWN_MS` | `600000` | 两轮插话间隔（10 分钟） |
| `INTERJECT_MAX_PER_HOUR` | `4` | 每群每小时上限 |
| `INTERJECT_RATE` | `1` | 判断该接后的最终概率 |

### 行为细节

- 判断「不该接」时**只消耗一次轻量判断调用**，不生成回复。
- 机器人自己刚插过话时，冷却期内不会再开口。
- 被 @ 的消息仍走正常回复，**不触发**插话判断（两者互斥）。

## 图片识别（多模态）

### 模型能力实测

| 模型 | 能否识图 | 说明 |
|---|---|---|
| `deepseek-flash` | ✅ 支持 | 实测能准确读出图片内容、画面文字与情绪 |
| `deepseek-v4-pro` | ❌ 不支持 | 返回 `[Unsupported Image]`，看不到图 |

所以**必须用 `deepseek-flash`**，换模型前先确认它支持 vision。

### 工作方式

```
对方发图 → 适配层拿到图片 URL
        → 下载（15s 超时，上限 8MB）
        → sharp 压到 768px JPEG
        → base64 data URL
        → 作为多模态内容块塞进 user 消息
        → deepseek-flash 直接看图回答
```

### 设计取舍

- **只识别当前这条消息里的图**，不重复送历史图片，否则 token 会爆炸。
- 单条最多 2 张（`VISION_MAX_IMAGES`），超出丢弃。
- 下载或转码失败时**自动降级**为纯文本回复，不会因为一张坏图卡死。
- 统一转成 JPEG：QQ 的图常是 WebP/GIF，部分上游不支持。

### 相关配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `VISION_ENABLED` | `true` | 总开关；关掉则完全不下载图片 |
| `VISION_MAX_IMAGES` | `2` | 单条消息最多识别几张图 |

> 注意：推理模型（`deepseek-flash`）处理图片时会先消耗大量 reasoning token，
> `LLM_MAX_TOKENS` 太小会导致正文为空。当前默认 1024，识别大图时建议调到 2048。

## 架构

```
NapCatQQ (QQ 协议端)
      │  OneBot v11 正向 WebSocket
      ▼
OneBotClient ── 连接管理 / echo 关联 / 指数退避重连
      │
      ▼
OneBotAdapter ── CQ 码或数组 → MessageSegment[] → MessageEvent
      │
      ▼
MessagePipeline ── 去重 → 触发判定 → 记忆 → 拼提示词 → 调模型 → 清洗 → 发送
      │            （按 platform:scene:peerId 串行排队）
      ▼
ChatAdapter.sendText()  ← 换平台只需实现这一层
```

关键文件：

| 文件 | 职责 |
|---|---|
| `src/adapters/onebot/client.ts` | WS 连接、API 调用、重连 |
| `src/adapters/onebot/segments.ts` | CQ 码解析、消息段归一化、纯文本渲染 |
| `src/adapters/onebot/adapter.ts` | 事件 → 内部模型；发送实现 |
| `src/core/pipeline.ts` | 主业务链路 + 串行队列 + 分片 |
| `src/core/trigger.ts` | 要不要回应的判定 |
| `src/core/prompt.ts` | 提示词拼装与回复清洗 |
| `src/core/memory.ts` | SQLite 记忆与去重 |
| `src/core/persona.ts` | 人设加载与热重载 |
| `src/core/llm.ts` | 模型调用、重试、错误诊断 |

## 测试与验证

```powershell
pnpm test          # 115 个用例：单元 + 端到端（真实 WS、真实 SQLite、假 LLM HTTP）
pnpm typecheck     # 类型检查
pnpm verify        # 协议合规性验证（真实进程，19 项检查，无需 Key）
pnpm verify:real   # 真实模型端到端验证（调用 .env 中配置的真实端点）
```

### 三层验证的区别

| 命令 | 是否调用真实模型 | 验证什么 |
|---|---|---|
| `pnpm test` | 否（假 HTTP 服务） | 业务逻辑：去重、触发、冷却、分片、清洗、重试 |
| `pnpm verify` | 否（严格校验协议的假服务） | 协议层：请求体规范、上下文拼装、发送格式 |
| `pnpm verify:real` | **是** | 真实链路的最终确认：模型真的能回、人格生效、上下文连贯 |

`pnpm verify:real` 会依次验证：@ 触发并收到真实回复、上下文承接上一轮、
人设约束（问「你是不是 AI」不应承认）、非 @ 消息不触发。

### 真实环境实测记录

在 DeepSeek 官方 API（`deepseek-flash`）上的实测：

- 「今天好热啊」→「热到我都想化在水里了，你那边多少度啊？别在外面瞎晃悠」
- 「那我该干嘛」→「找个有空调的地方待着啊，别想不开大中午往外跑……」（**正确承接了「热」这个话题**）
- 「你是不是AI啊」→「你才是AI呢……」（**人设约束生效**）

## 已知限制与风险

- **NapCat 属于非官方协议实现**，存在账号被风控的风险。建议用小号，并先在小群里灰度；
  它随 QQ 客户端版本更新可能失效，需要跟进社区版本。
- 当前 `BOT_SELF_ID` 留空时会从第一条事件自动学习；若机器人拉起来之前有群消息积压，
  建议显式填写。
- 上下文只有「滑动窗口」，**没有做摘要压缩**：长对话会持续占用 token。
- 主动插话默认关闭，开启后每轮判断仍需一次模型调用（详见下一节成本表）。
- SQLite 为单写者模式，机器人单实例运行没问题；多实例共享同一 `DATA_DIR` 会有锁竞争。
- 推理模型（`deepseek-flash`）会消耗 reasoning token，`LLM_MAX_TOKENS` 过小会导致
  回复为空；代码已识别该情况并给出明确提示，但仍需把值调够。

## 路线图

1. 表情包入库与向量检索（图片描述 + 嵌入 + 相似度召回）
2. 发图能力（本地图 / 生图 API / 网图）
3. 上下文摘要压缩，控制长会话 token 成本
4. 企业微信回调适配器（零封号风险，覆盖企微群）
5. 管理命令（`/reload`、`/persona`、`/stats`）与简单 Web 面板

## 许可证

本项目采用 [MIT License](LICENSE) 开源。

```
Copyright (c) 2026 whale-chan contributors
```

简单说：可以自由使用、修改、分发、商用，保留版权声明即可。

---

## 免责声明

- 本项目仅供学习与技术研究。使用 NapCat 等非官方协议实现接入 QQ 存在账号风控风险，
  请自行评估并优先使用小号。
- 语音克隆、图片生成等功能涉及第三方模型与素材版权，使用者需自行确保合规。
- 请遵守所在平台的服务条款与当地法律法规。


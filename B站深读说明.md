# B 站深读：抽帧看画面 + 本地转写台词

实现时间：2026-10-22

---

## 一、三层信息，按成本分层

```
第 1 层  弹幕 + 评论 + 元数据       1~3 秒    零成本      已上线
第 2 层  抽帧看画面                10~25 秒   几千 token   本次新增
第 3 层  本地 whisper 转写台词      视频时长×0.11  占显卡      本次新增
```

**默认只跑第 1 层**，第 2/3 层由触发条件决定。原因很简单：热门视频弹幕已经够聊，
没必要让用户白等十几秒。

---

## 二、实测数据

### 抽帧（106 秒视频）

```
视频流下载: 0.83 MB (480p H.264)
抽帧:      9 帧 / 153 KB / 1.6 秒
```

画面里的文字清晰可读——抽出来的第一帧是黑底白字：

> 我们都知道 Windows激活机制 是非常优秀的机制 但是Linux不能激活 为什么不开拓Linux市场呢

### 转写（本地 faster-whisper，RTX 2070）

| 模型 | 耗时（105 秒音频） | 倍率 | 质量 |
|---|---|---|---|
| **small** | **5.0 秒** | **20.9x** | 一般，偶有错字 |
| large-v3 | 29.8 秒 | 3.5x | 明显更准 |

默认用 `small`——群聊等不起 30 秒。

---

## 三、真实对话效果

### 场景 A：普通问「讲了啥」（只走弹幕，秒回）

> 大概是整活：在 Linux 桌面上复刻 Windows 右下角那行"激活 Windows"水印，还做了个叫 Linux-Activator 的演示项目，配置能高度自定义

### 场景 B：明确说「看看画面里是啥」（触发抽帧）

> 画面里就是在虚拟机 Ubuntu 里整活复刻 Windows 激活流程：开头一本正经地说"Windows 激活机制非常优秀，但 Linux 不能激活，为什么不开拓 Linux 市场呢"，然后终端里 cd 进 activate-linux 跑

**关键**：「虚拟机 Ubuntu」「终端里 cd 进」——这些只能从画面看到，弹幕里没有。

### 场景 C：明确说「视频里说了什么」（触发转写）

> UP主一本正经地说"Windows激活机制非常优秀，但Linux不能激活"…在Linux上弹激活界面、输激活码还有50%概率成功，激活后水印消失；配置文件还能改激活状态…最后他坦白代码是两位开发者的，自己只负责出鬼点子

**关键**：「50% 概率」「感谢两位开发者」——这些台词细节，转写才能拿到。

---

## 四、触发策略

| 条件 | 行为 |
|---|---|
| 弹幕 < `BILI_SPARSE_THRESHOLD`（默认 30） | 自动抽帧 |
| 用户说「看画面 / 画面里 / 长什么样」 | 强制抽帧 |
| 用户说「说了什么 / 听一下 / 台词 / 原话 / 声音」 | 触发转写（限短视频） |
| 视频长度 > `BILI_ASR_MAX_SECONDS`（默认 600 秒） | 不做转写 |
| 其他情况 | 只用弹幕，秒回 |

### 触发词的坑（2026-10-23 修）

第一版只认「说了 / 台词 / 原话 / 念了」，结果真实用户说了三次才成功：

| 用户原话 | 第一版 | 现在 |
|---|---|---|
| 「看下这个视频讲了啥」 | ❌ 不触发 | ✅ 触发 |
| 「不只看弹幕，看下听一下这个视频讲了啥」 | ❌ 不触发 | ✅ 触发 |
| 「视频里说了什么？」 | ✅ 触发 | ✅ 触发 |

**教训**：写触发词时不能只按自己想当然的说法，要拿真实消息回归。
现在的规则覆盖「说/讲/念/听/读 + 什么/啥/一下/声音」以及
「台词/原话/口播/旁白/语音」和「不看弹幕/听一下」这类强调说法。

误伤检查：「这个视频怎么样」「哈哈哈」仍然不触发，符合预期。

### 转写失败时的措辞（同批修复）

之前转写失败会静默降级，模型不知道发生了什么，就回「我听不到声音」——
这会让用户以为功能没做。

现在失败时会注入一段说明，让模型说「这次没能把语音转出来」，
而不是「我没有这能力」——**临时故障和功能缺失是两回事**。

---

## 五、真实故障：mkdir EPERM（根因是低完整性级别）

### 现象

2026-10-22 22:51 那条消息触发了转写，但报错：

```
EPERM: operation not permitted, mkdir 'C:\Users\ADMINI~1\...\wc-asr-...\out'
```

**退出火绒后依然失败**，而且每次都在 0.75 秒内精确失败——
说明这不是偶发竞态，而是确定性错误。

### 逐步隔离

| 实验 | 结果 |
|---|---|
| TEMP 目录 ACL | 正常，Administrator FullControl |
| 短名 `ADMINI~1` 路径 | 单独测正常 |
| 300 次 mkdir 压测（当前 shell） | 300 成功 0 失败 |
| 检查过滤驱动 | 有 `sysdiag`（火绒），但退出其进程后仍失败 |

真正的突破口是**换 exe 位置**（同一份 node.exe，同版本/同大小/同签名）：

| exe 位置 | 写 C 盘 TEMP | 写 E 盘项目目录 |
|---|---|---|
| `E:\PRO\etc\daliy\runtime\node.exe` | ❌ EPERM | ✅ OK |
| `C:\Users\...\node-test\node.exe` | ✅ OK | ✅ OK |

### 根因：进程以「低完整性级别」运行

```
E:\PRO\etc\daliy\runtime\node.exe   → Mandatory Label\Low Mandatory Level  (S-1-16-4096)
C:\Users\<用户名>\...\node.exe → Mandatory Label\High Mandatory Level (S-1-16-12288)
```

Windows 的完整性级别有个核心规则：**低完整性进程不能写入更高完整性的对象**。

- C 盘用户 TEMP 的默认 IL 是 Medium → Low IL 进程被拒 → EPERM
- E 盘项目目录的 ACL 给了 Authenticated Users 写权限，且 IL 匹配 → 能写

所以现象是「有的地方能写、有的地方不能」，极具迷惑性。

### 为什么 E 盘那个会变成 Low

目录上没有显式完整性标签（SACL 干净），
推测是该路径落在某种沙箱/重定向策略的覆盖范围内
（本机装有腾讯电脑管家等组件，可能对特定目录做了处理）。

**这一点没有 100% 确证**，但修复方向是确定的。

### 修法：把 Node 运行时移到 C 盘用户目录

```
旧: E:\PRO\etc\daliy\runtime\node-v22.22.2-win-x64\
新: C:\Users\<用户名>\.whale-chan-runtime\node-v22.22.2-win-x64\
```

改了两处：

| 文件 | 改动 |
|---|---|
| `scripts/watchdog.ps1` | `$RuntimeDir` 指向 C 盘 |
| `src/web/control-api.ts` | `NODE_CANDIDATES` 首选 C 盘，E 盘降为候选 |

`BILI_ASR_PYTHON` 不用改——它指向 Python，Python 由 node 子进程启动，继承的是 node 的完整性。

### 验证

```
新位置 C 盘 node:
  Mandatory Label\High Mandatory Level
  mkdir OK -> C:\Users\ADMINI~1\AppData\Local\Temp\wc-newint-...

真实转写（547 秒视频）:
  ✅ 转写成功 2282 字 / 28s（19.5x 实时）
```

### 保留的防御

`mkdirWithRetry` 的退避重试仍然保留——虽然这次根因不是偶发，
但真实的瞬时 I/O 争用（杀软扫描、索引服务）确实存在，重试成本极低。

### 教训

**「权限正常」不等于「能写」**。ACL 显示 FullControl 时，
还要看进程的完整性级别——这是 ACL 完全看不到的另一层权限模型。

排查这类问题最有效的手段是**控制变量换位置**：
同一份二进制，换个目录就跑通，立刻锁定是路径/环境问题而非代码问题。

---

## 五、抽帧规划

按时长自适应间隔，帧数硬上限（默认 12 张）：

| 视频时长 | 间隔 | 帧数 |
|---|---|---|
| ≤ 60 秒 | 6 秒 | ≤ 10 |
| 3 分钟 | 15 秒 | 12 |
| 10 分钟 | 50 秒 | 12 |
| 30 分钟 | 150 秒 | 12 |
| 2 小时 | 600 秒 | 12 |

帧数上限的意义：每张约 300~500 token，12 张约 4~6k token，可控。

---

## 六、本地 ASR 复用说明

**没有重新装环境**，直接复用你已有的：

```
D:\VideoTranscribe\venv\Scripts\python.exe    ← faster-whisper 1.2.1 + CUDA 12 库
D:\VideoTranscribe\transcribe.py              ← 转录脚本
D:\VideoTranscribe\models\small               ← 464 MB
D:\VideoTranscribe\models\large-v3            ← 2.9 GB
```

调用方式（和手动拖文件完全一样）：

```bash
python transcribe.py audio.m4a --model small --lang zh --format all --outdir <dir>
```

输出 `<stem>.txt` 和 `<stem>.ts.txt`（带时间戳），后者用于注入提示词。

**音频不出本机**：全程本地 GPU 推理，不联网上传。

---

## 七、配置项

| 变量 | 默认 | 说明 |
|---|---|---|
| `BILI_DEEP_READ` | true | 深读总开关 |
| `BILI_SPARSE_THRESHOLD` | 30 | 弹幕少于多少条才抽帧 |
| `BILI_MAX_FRAMES` | 12 | 抽帧上限 |
| `BILI_ASR_MAX_SECONDS` | 600 | 只转写这么短的视频 |
| `BILI_ASR_MODEL` | small | small（快）或 large-v3（准） |
| `BILI_ASR_PYTHON` | D:\VideoTranscribe\venv\Scripts\python.exe | whisper 环境 |
| `BILI_ASR_SCRIPT` | D:\VideoTranscribe\transcribe.py | 转写脚本 |
| `FFMPEG_PATH` | ffmpeg | 抽帧用，填 `ffmpeg` 表示走 PATH |

### 调参建议

| 想要 | 调整 |
|---|---|
| 更快 | `BILI_DEEP_READ=false` 只用弹幕 |
| 画质更清楚 | `BILI_MAX_FRAMES` 调到 20（代价是更多 token） |
| 转写更准 | `BILI_ASR_MODEL=large-v3`（慢 6 倍） |
| 长视频也转写 | `BILI_ASR_MAX_SECONDS` 调大（30 分钟约需 3 分钟） |

---

## 八、已知边界

| 情况 | 表现 |
|---|---|
| 充电专属 / 付费视频 | 拿不到流地址，只有弹幕 |
| 纯音乐视频 | 转写出来是空的（没人说话） |
| 画面无文字的教程 | 抽帧信息量低，不如弹幕 |
| 超长视频 | 抽帧间隔很大，可能漏掉中段关键画面 |
| 显存被占用 | 转写失败，自动降级为只用弹幕 |

**最重要的一条**：抽帧是**稀疏采样**，不是"看完视频"。
12 帧覆盖 10 分钟视频，平均 50 秒才一张，中间的快速切换会漏掉。
所以提示词里要求模型"看不清就说看不清，不要编"。

---

## 九、文件清单

| 文件 | 说明 |
|---|---|
| `src/core/media.ts` | 抽帧规划、视频/音频下载、ASR 调用、渲染 |
| `src/core/bilibili.ts` | 新增 `fetchStreams`（取 DASH 流地址） |
| `src/core/pipeline.ts` | `readBilibili` 三层编排 + 触发判断 |
| `src/config.ts` | 8 个新配置项 |
| `src/core/config-schema.ts` | 配置界面新增 8 项 |
| `test/media.test.ts` | 17 个单测 |
| `scripts/verify-media.ts` | 媒体层验证（抽帧+转写） |
| `scripts/verify-deepread.ts` | 完整链路验证（3 场景） |

全量测试：**174 个**（原 157 + 新增 17），全部通过。

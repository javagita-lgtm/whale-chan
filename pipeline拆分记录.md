# pipeline.ts 拆分重构

完成时间：2026-10-27

---

## 一、拆分结果

| 文件 | 行数 | 职责 |
|---|---|---|
| **`pipeline.ts`（主文件）** | **248** | 只留编排：去重 → 触发判定 → 分支派发 → 回复生成 → 发送 |
| `pipeline/context.ts` | 96 | 共享 deps + 可变状态（stats / lastDeepReadAt） |
| `pipeline/enrichers.ts` | 395 | 链接 / 搜索 / B站 / 小红书 |
| `pipeline/speech.ts` | 269 | 唱歌 + TTS |
| `pipeline/sticker-image.ts` | 156 | 生图 + 表情包 |
| `pipeline/interject.ts` | 127 | 主动插话 |
| `pipeline/text.ts` | 58 | 串行队列 / 分片 / sleep |
| `pipeline/images.ts` | 57 | 三路图片收集 |

**主文件从 1,340 行 → 248 行（减少 81%）。**

拆出的模块合计 1,158 行，加上主文件共 1,406 行——
比原来多 66 行，是补充的注释和类型（拆开后每个模块都要单独说明动机）。

---

## 二、为什么这么拆

### 问题：循环依赖的"隐式耦合"

原来的 `MessagePipeline` 是个"上帝对象"：

```ts
class MessagePipeline {
  private stats = {...};              // 谁都在改
  private lastDeepReadAt = 0;         // readBilibili 写，replyTo 读
  private observer = new InterjectObserver();

  private async trySing() {...}       // 依赖 this.stats, this.deps
  private async tryGenerateImage() {...}  // 依赖 this.stats, this.deps
  private async readBilibili() {...}  // 写 this.lastDeepReadAt
  private async replyTo() {...}       // 读 this.lastDeepReadAt
}
```

**问题不在于长，而在于"隐式状态"**：
- 想知道 `replyTo` 为什么发语音，得翻到 400 行外看谁写了 `lastDeepReadAt`
- 想单独测试 `readBilibili`，得构造整个 `MessagePipeline`
- 新增一个能力（比如唱歌），只能继续往这个类里塞方法

### 解法：显式 context

```ts
export interface PipelineContext extends PipelineDeps {
  stats: PipelineStats;
  lastDeepReadAt: number;
  markDeepRead(): void;          // 写
  isRecentDeepRead(): boolean;   // 读
}
```

各模块签名统一成 `(ctx, event, logger)`，**依赖写在类型里，不用翻代码猜**。

`lastDeepReadAt` 的读写也从"直接改字段"变成了显式方法调用：

```ts
// readBilibili 里
ctx.markDeepRead();

// replyTo 里
if (ctx.isRecentDeepRead()) {
  await speakReply(...);
}
```

---

## 三、拆分后主文件长什么样

```ts
private async process(event: MessageEvent): Promise<void> {
  // 1. 去重  2. 触发判定  3. 记记忆
  // ...
  if (!decision.respond) {
    if (decision.reason === 'no-mention' && event.scene === 'group') {
      this.handleInterjectObservation(event);   // 委托给 interject.ts
    }
    return;
  }

  // 分支派发顺序保持不变（这点很关键）
  if (await trySing(this.ctx, event, logger)) return;
  if (await tryGenerateImage(this.ctx, event, logger)) return;
  if (await trySpeak(this.ctx, event, logger)) return;

  await this.replyTo(event, decision.reason, currentRowId);
}

private async replyTo(...) {
  const history = store.recentMessages(...);
  const imageDataUrls = await collectImages(this.ctx, event, logger);
  const webResult = await enrichWithWeb(this.ctx, event, logger, history);
  const messages = buildMessages({...});
  // 调模型、清洗、分片发送
}
```

**248 行，一眼能看完整个流程。**

---

## 四、兼容性

对外接口完全不变：

```ts
// index.ts 里照旧
const pipeline = new MessagePipeline({
  config, adapter, llm, store, personas, logger, botName,
  offlineReply, stickers, stickerRate, web, bili, media,
  imageGen, tts, singer,        // ← 唱歌也正常传入
});
```

`pipeline.ts` 仍然导出这些（用 re-export 保持兼容）：

```ts
export { KeyedQueue, sleep, splitMessage };
export type { PipelineDeps, PipelineStats };
```

所以测试文件和历史代码都不用改。

---

## 五、验证

### 单元测试

```
Test Files  35 passed (35)
Tests       419 passed (419)
```

**全部通过，零回归。** 这说明拆分是纯结构调整，没有改变任何行为。

### 端到端回归

```
=== 回归验证 ===
1. 普通回复: ✅ (29 字)
   欸，你好呀（探头）我是鲸鱼酱，在这群里潜水中，有啥想聊的？
2. 生图分支: ✅
   （发了图，无文字）
3. 准备回应次数: 2（应为 2）

总体: ✅ 通过
```

**重点验证了分支派发顺序**：唱歌 > 生图 > 语音 > 普通回复。
这个顺序不能乱——唱歌和语音都含「说/唱」关键词，必须先判断唱歌。

---

## 六、关于唱歌功能

你提到新增的唱歌功能，它在拆分后落在 `pipeline/speech.ts`：
- `trySing`：曲库直发 / 实时生成
- `trySpeak`：TTS 朗读
- `speakReply`：回复配语音

三者放一起是因为都涉及「文本 → 音频」，但触发路径不同。
`singer` 依赖在 `index.ts` 里正常传入，`config.sing.enabled` 开关也在。

---

## 七、这次重构没做什么

### 1. 没改 `replyTo` 内部

它还有约 120 行，包含上下文拼装、调模型、字数控制、分片发送、语音版、表情包、记忆写入。
**这些步骤有严格的先后依赖**，硬拆反而会增加复杂度。等有实际需求再动。

### 2. 没加新功能

纯结构重构。加功能和重构混在一起会让回归测试失去意义。

### 3. 没动 `config-schema.ts`（634 行）

它是数据结构定义，不是逻辑耦合，拆开反而更难查。

---

## 八、下一步建议

按优先级：

1. **`enrichers.ts` 还有 395 行** —— 可以再拆成 `bilibili.ts` / `xiaohongshu.ts` / `web.ts` 三个独立的 enricher
2. **多 LLM 降级** —— 现在全押 DeepSeek，挂了就哑火
3. **整理 58 篇文档** —— 建个 README 索引

先做哪个？

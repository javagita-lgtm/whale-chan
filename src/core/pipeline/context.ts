/**
 * 管线的共享上下文。
 *
 * 拆分的核心动机：原来 1,340 行的 MessagePipeline 里，
 * 生图/唱歌/语音/链接阅读/插话判断全都挂在这一个类上，
 * 靠 `this.stats`、`this.lastDeepReadAt`、`this.observer` 互相纠缠。
 *
 * 现在把这些可变状态收进一个显式的 context 对象，各功能模块只依赖它，
 * 不再依赖"某个类的私有字段"。好处：
 *   1. 每个模块可以单独测试（传一个 fake context 就行）
 *   2. 依赖关系写在类型里，不用翻代码猜
 *   3. 新增能力时不用再往一个大类里塞方法
 */

import type { AppConfig } from '../../config.js';
import type { ChatAdapter, MessageEvent } from '../types.js';
import type { Logger } from '../logger.js';
import type { LlmClient } from '../llm.js';
import type { MemoryStore } from '../memory.js';
import type { PersonaStore } from '../persona.js';
import type { StickerIndex } from '../stickers.js';
import type { WebTools } from '../web.js';
import type { BilibiliClient } from '../bilibili.js';
import type { BiliMedia } from '../media.js';
import type { ImageGenerator } from '../image-gen.js';
import type { TtsClient } from '../tts.js';
import type { Singer } from '../singer.js';
import type { SingJobQueue } from '../sing-queue.js';

/** 运行时统计。各 handler 直接累加。 */
export interface PipelineStats {
  received: number;
  deduped: number;
  skipped: number;
  replied: number;
  failed: number;
  stickers: number;
  interjected: number;
}

export function createStats(): PipelineStats {
  return { received: 0, deduped: 0, skipped: 0, replied: 0, failed: 0, stickers: 0, interjected: 0 };
}

/**
 * 管线依赖。全部可选的能力用 `| null` 表示"未启用"，
 * 与旧 PipelineDeps 保持兼容（index.ts 传的就是这套字段）。
 */
export interface PipelineDeps {
  config: AppConfig;
  adapter: ChatAdapter;
  llm: LlmClient;
  store: MemoryStore;
  personas: PersonaStore;
  logger: Logger;
  /** 机器人在群里的称呼 */
  botName: string;
  /** 离线兜底回复生成器（未配置 API Key 时使用） */
  offlineReply?: (event: MessageEvent) => string;
  stickers?: StickerIndex | null;
  stickerRate?: number;
  web?: WebTools | null;
  bili?: BilibiliClient | null;
  media?: BiliMedia | null;
  imageGen?: ImageGenerator | null;
  tts?: TtsClient | null;
  singer?: Singer | null;
  /** 唱歌任务队列（异步生成用） */
  jobs?: SingJobQueue | null;
}

/**
 * 传给各功能模块的上下文。
 *
 * 除了 deps 还带两个**可变状态**，这是拆分时最容易出错的地方：
 *   - stats：各 handler 都要累加计数
 *   - lastDeepReadAt：视频深读的时间戳，replyTo 用它决定要不要补发语音
 *
 * 用一个共享对象而不是返回值传递，是为了不改动各 handler 的签名风格。
 */
export interface PipelineContext extends PipelineDeps {
  stats: PipelineStats;
  /** 最近一次视频深读的时间戳（ms）。0 表示从未深读过。 */
  lastDeepReadAt: number;
  /** 记录一次视频深读，供 replyTo 判断是否补发语音 */
  markDeepRead(): void;
  /** 判断刚才是否做过深读（2 分钟内） */
  isRecentDeepRead(windowMs?: number): boolean;
}

export function createContext(deps: PipelineDeps): PipelineContext {
  const stats = createStats();
  const ctx: PipelineContext = {
    ...deps,
    stats,
    lastDeepReadAt: 0,
    markDeepRead() {
      ctx.lastDeepReadAt = Date.now();
    },
    isRecentDeepRead(windowMs = 120_000) {
      return ctx.lastDeepReadAt > 0 && Date.now() - ctx.lastDeepReadAt < windowMs;
    },
  };
  return ctx;
}

/**
 * 消息管线：收到内部事件 → 去重 → 触发判定 → 记忆 → 拼提示词 → 调模型 → 清洗 → 发送。
 *
 * 每个会话（群/私聊）一把串行锁：同群消息按顺序处理，避免回复乱序；
 * 不同群之间互不阻塞。
 *
 * 【2026-10-27 重构】原来 1,340 行，生图/唱歌/语音/链接阅读/插话判断全挂在这一个类上。
 * 现在按职责拆到 pipeline/ 子目录：
 *   context.ts       共享 deps 与可变状态
 *   text.ts          串行队列、分片、sleep
 *   enrichers.ts     链接/搜索/B站/小红书
 *   images.ts        三路图片收集
 *   speech.ts        唱歌与 TTS
 *   sticker-image.ts 生图与表情包
 *   interject.ts     主动插话
 *
 * 本文件只保留编排逻辑：判断顺序、上下文拼装、回复生成与发送。
 */

import type { MessageEvent } from './types.js';
import type { Logger } from './logger.js';
import { buildMessages, extractStickerHint, sanitizeReply } from './prompt.js';
import { decideTrigger } from './trigger.js';
import { resolveReplyLimitWithRecap } from './topic.js';
import { InterjectObserver } from './interject.js';

import {
  createContext,
  type PipelineContext,
  type PipelineDeps,
  type PipelineStats,
} from './pipeline/context.js';
import { KeyedQueue, sleep, splitMessage } from './pipeline/text.js';
import { enrichWithWeb } from './pipeline/enrichers.js';
import { collectImages } from './pipeline/images.js';
import { speakReply, trySing, trySpeak } from './pipeline/speech.js';
import {
  maybeSendSticker,
  pickStickerCandidates,
  tryGenerateImage,
} from './pipeline/sticker-image.js';
import { decideInterject, observeForInterject } from './pipeline/interject.js';

// 保持对外导出的兼容性：原来这些都能从 pipeline.js 直接 import
export { KeyedQueue, sleep, splitMessage } from './pipeline/text.js';
export type { PipelineDeps, PipelineStats } from './pipeline/context.js';

export class MessagePipeline {
  private readonly queue = new KeyedQueue();
  private readonly ignorePatterns: RegExp[] = [];
  /** 主动插话观察器 */
  private readonly observer = new InterjectObserver();
  private readonly ctx: PipelineContext;

  constructor(deps: PipelineDeps) {
    this.ctx = createContext(deps);
  }

  getStats(): PipelineStats {
    return { ...this.ctx.stats };
  }

  handle(event: MessageEvent): void {
    this.ctx.stats.received++;
    const key = `${event.platform}:${event.scene}:${event.peerId}`;
    void this.queue
      .enqueue(key, () => this.process(event))
      .catch((error: unknown) => {
        this.ctx.logger.error('消息处理失败', {
          peerId: event.peerId,
          message: (error as Error).message,
        });
      });
  }

  private async process(event: MessageEvent): Promise<void> {
    const { config, store, logger } = this.ctx;

    // 1. 幂等去重
    const seenKey = `${event.platform}:${event.scene}:${event.peerId}:${event.messageId}`;
    if (!store.markSeen(seenKey)) {
      this.ctx.stats.deduped++;
      logger.debug('重复消息，已忽略', { messageId: event.messageId });
      return;
    }

    // 2. 触发判定
    const decision = decideTrigger(event, {
      config: config.trigger,
      store,
      ignorePatterns: this.ignorePatterns,
    });

    // 3. 无论是否回应，都记进记忆（机器人需要看到群里发生了什么）
    const currentRowId = store.appendMessage(event.platform, {
      scene: event.scene,
      peerId: event.peerId,
      userId: event.sender.userId,
      nickname: event.sender.nickname || event.sender.userId,
      text: event.text,
      mentionsBot: event.mentionsBot,
      fromSelf: event.fromSelf,
      timestamp: event.timestamp,
    });

    if (!decision.respond) {
      // 群聊未 @ 时，交给主动插话观察器攒批判断（不立即回应，零 token）
      if (decision.reason === 'no-mention' && event.scene === 'group') {
        this.handleInterjectObservation(event);
      }
      this.ctx.stats.skipped++;
      logger.debug('不回应', { reason: decision.reason, peerId: event.peerId });
      return;
    }

    logger.info('准备回应', {
      scene: event.scene,
      peerId: event.peerId,
      nickname: event.sender.nickname,
      reason: decision.reason,
      text: event.text.slice(0, 60),
    });

    // 唱歌排最前：它和「语音」都含「说/唱」，必须先判断
    if (await trySing(this.ctx, event, logger)) return;

    // 生图优先：命中触发词就直接出图，不走普通回复
    // （生图本身要花十几秒，再拼一段闲聊会让用户等更久）
    if (await tryGenerateImage(this.ctx, event, logger)) return;

    // 语音次之：说「念一下xxx」就合成语音发出去
    if (await trySpeak(this.ctx, event, logger)) return;

    await this.replyTo(event, decision.reason, currentRowId);
  }

  /** 攒批判断要不要主动插话；到点才真的调模型。 */
  private handleInterjectObservation(event: MessageEvent): void {
    const { logger } = this.ctx;
    const batch = observeForInterject(this.ctx, this.observer, event, logger);
    if (!batch) return;

    void decideInterject(this.ctx, event, batch, logger)
      .then(async (trigger) => {
        // 要接话：用批里最后一条消息作为「当前消息」走正常回复
        if (trigger) await this.replyTo(trigger, 'interject');
      })
      .catch((error: unknown) => {
        logger.warn('插话判断失败', { message: (error as Error).message });
      });
  }

  /**
   * 生成并发送一条回复。
   * @param event 作为「当前消息」的事件
   * @param reason 触发原因（mention/private/interject），影响提示词措辞
   * @param currentRowId 已写入的当前消息行号，拉上下文时排除
   */
  private async replyTo(
    event: MessageEvent,
    reason: 'mention' | 'private' | 'interject',
    currentRowId?: number,
  ): Promise<void> {
    const { config, store, logger, stats } = this.ctx;

    // 4. 拉上下文（排除刚落库的当前消息，它会在提示词里单独出现）
    const sinceMs = Date.now() - config.context.historyWindowMinutes * 60_000;
    const history = store.recentMessages(
      event.platform,
      event.scene,
      event.peerId,
      config.context.maxHistoryMessages,
      sinceMs,
      currentRowId,
    );

    const persona = this.ctx.personas.get(
      undefined,
      event.scene === 'group' ? event.peerId : undefined,
    );

    // 为模型准备表情包候选：按当前话题检索一批，让它从真实存在的图里挑。
    const stickerCandidates = pickStickerCandidates(this.ctx, event.text);

    // 消息里带图时，下载并转成 data URL 送给多模态模型
    const imageDataUrls = await collectImages(this.ctx, event, logger);

    // 链接阅读 / 联网搜索：拿到内容就注入提示词，拿不到就算了（不阻断回复）
    // 传 history 是为了消解搜索词里的代词（"他爹" → "杨少华"）
    const webResult = await enrichWithWeb(this.ctx, event, logger, history);

    const messages = buildMessages({
      persona,
      event,
      history,
      maxContextChars: config.context.maxContextChars,
      botName: this.ctx.botName,
      stickerCandidates,
      // B 站抽帧得到的画面也要图给模型，和消息里的图合并
      imageDataUrls: [...imageDataUrls, ...webResult.frameDataUrls],
      proactive: reason === 'interject',
      pageBlocks: webResult.pageBlocks,
      searchBlock: webResult.searchBlock,
    });

    // 5. 调模型
    let replyText: string;
    let stickerHint: string | null = null;
    try {
      if (!this.ctx.llm.enabled) {
        replyText = this.ctx.offlineReply
          ? this.ctx.offlineReply(event)
          : '（离线模式：尚未配置 LLM_API_KEY）';
      } else {
        const result = await this.ctx.llm.complete(messages);
        const extracted = extractStickerHint(result.content);
        stickerHint = extracted.hint;
        // 字数上限随任务类型浮动：闲聊短、技术放宽、内容交代次之、详细模式最宽
        const { limit, kind } = resolveReplyLimitWithRecap(
          persona.replyMaxChars,
          persona.replyTechMaxChars,
          persona.replyRecapMaxChars,
          [event.text, ...history.slice(-3).map((h) => h.text)],
          persona.replyDetailMaxChars,
        );
        if (kind !== 'chat') logger.debug('放宽字数上限', { kind, limit });
        replyText = sanitizeReply(extracted.text, limit);
      }
    } catch (error) {
      stats.failed++;
      logger.error('模型调用失败', { message: (error as Error).message });
      replyText = '（好像卡了一下，等下再说）';
    }

    if (replyText.length === 0) {
      logger.warn('清洗后回复为空，跳过发送');
      return;
    }

    // 6. 模拟真人打字停顿（避免秒回带来的机械感）
    if (config.bot.typingDelayMaxMs > 0) {
      const delay = Math.min(config.bot.typingDelayMaxMs, Math.max(400, replyText.length * 60));
      await sleep(Math.floor(delay * (0.5 + Math.random() * 0.5)));
    }

    // 7. 发送：超长回复按平台上限分片，逐条发
    const chunks = splitMessage(replyText, config.bot.maxMessageChars);
    for (let i = 0; i < chunks.length; i++) {
      await this.ctx.adapter.sendText(event.scene, event.peerId, chunks[i] as string);
      if (i < chunks.length - 1) await sleep(300);
    }
    stats.replied++;

    // 7.2 语音版：视频深读类回复额外发一份朗读。
    //     用户要求「文字和语音两份」：文字给看，语音给听。
    //     只在真的做了转写/深读时触发，闲聊不额外发语音（否则太吵）。
    if (this.ctx.isRecentDeepRead()) {
      await speakReply(this.ctx, event, replyText, logger);
    }

    // 7.5 表情包：模型给了 hint 才尝试发
    if (stickerHint) {
      logger.info('模型请求发表情包', { hint: stickerHint });
      await maybeSendSticker(this.ctx, event, stickerHint, logger);
    } else {
      logger.debug('模型未请求表情包');
    }

    // 8. 记录自己的回复，供后续上下文使用
    store.appendMessage(event.platform, {
      scene: event.scene,
      peerId: event.peerId,
      userId: this.ctx.botName,
      nickname: this.ctx.botName,
      text: replyText,
      mentionsBot: false,
      fromSelf: true,
      timestamp: Math.floor(Date.now() / 1000),
    });
  }
}

/**
 * 生图与表情包。
 *
 * 从 pipeline.ts 抽出。两者都是「命中特定条件就发东西出去」的分支，
 * 处理完直接 return true，不再走普通回复流程。
 */

import type { MessageEvent } from '../types.js';
import type { Logger } from '../logger.js';
import { buildImageCaption, wantsImage } from '../image-gen.js';
import type { PipelineContext } from './context.js';
import { sleep } from './text.js';

/**
 * 命中生图触发词时出图并发送。
 * @returns true 表示已处理（调用方不再走普通回复）
 */
export async function tryGenerateImage(
  ctx: PipelineContext,
  event: MessageEvent,
  logger: Logger,
): Promise<boolean> {
  const { config, imageGen, adapter, stats, store, botName } = ctx;
  // 用可选链：旧配置/测试桩里可能没有 imageGen 字段，
  // 直接访问 .enabled 会抛错并中断整条回复链路。
  if (!config.imageGen?.enabled || !imageGen) return false;
  if (!wantsImage(event.text)) return false;

  logger.info('触发生图', {
    scene: event.scene,
    text: event.text.slice(0, 60),
  });

  const reply = await imageGen.handle({
    text: event.text,
    isPrivate: event.scene === 'private',
  });

  // 先发说明文字（如果有），再发图
  const caption = buildImageCaption(reply, event.text);

  if (reply.ok && reply.filePath) {
    try {
      if (caption) await adapter.sendText(event.scene, event.peerId, caption);
      await adapter.sendImage(event.scene, event.peerId, reply.filePath);
      stats.replied++;
      logger.info('生图已发送', { file: reply.filePath, elapsedMs: reply.elapsedMs });
      // 记录到记忆，让后续对话知道刚画过图
      store.appendMessage(event.platform, {
        scene: event.scene,
        peerId: event.peerId,
        userId: botName,
        nickname: botName,
        text:
          caption ||
          `（发了张图：${event.text.replace(/\[艾特你\]/g, '').trim().slice(0, 40)}）`,
        mentionsBot: false,
        fromSelf: true,
        timestamp: Math.floor(Date.now() / 1000),
      });
      return true;
    } catch (error) {
      logger.info('生图发送失败', { message: (error as Error).message.slice(0, 150) });
    }
  }

  // 失败：发一句说明，不让用户干等
  const failText = reply.message ?? '画不出来';
  try {
    await adapter.sendText(event.scene, event.peerId, failText);
    stats.replied++;
  } catch {
    /* 发不出去就算了 */
  }
  return true;
}

/**
 * 按当前话题检索一批真实存在的表情包，供模型挑选。
 *
 * 话题完全对不上时补若干随机图，让模型有更宽的挑选面（同 id 去重）。
 */
export function pickStickerCandidates(
  ctx: PipelineContext,
  text: string,
): Array<{ id: string; title: string }> {
  const { stickers } = ctx;
  if (!stickers || stickers.count() === 0) return [];

  const hits = stickers.search(text, 8, 0.25).map((h) => ({ id: h.id, title: h.title }));
  if (hits.length < 4) {
    // 补充若干随机图，让模型有更宽的挑选面（同 id 去重）
    const seen = new Set(hits.map((h) => h.id));
    for (let i = 0; i < 8 - hits.length; i++) {
      const r = stickers.random([...seen]);
      if (!r) break;
      seen.add(r.id);
      hits.push({ id: r.id, title: r.title });
    }
  }
  return hits;
}

/**
 * 根据模型给出的选择发送一张表情包。
 *
 * 模型输出的是图库编号（如 029），直接按 id 取图，不再做模糊检索——
 * 避免「模型描述一种情绪、图库没有这种描述」导致永远命中 0 条。
 *
 * 三重保护，避免刷屏：
 *   1. 概率闸
 *   2. 同会话冷却（默认 5 分钟）
 *   3. id 必须真实存在
 */
export async function maybeSendSticker(
  ctx: PipelineContext,
  event: MessageEvent,
  hint: string,
  logger: Logger,
): Promise<void> {
  const { stickers, store, adapter, stats, config, botName, stickerRate } = ctx;
  if (!stickers || stickers.count() === 0) return;

  const rate = stickerRate ?? 0.6;
  if (Math.random() > rate) {
    logger.debug('表情包概率闸未通过', { hint });
    return;
  }

  // 会话级冷却
  const cooldownKey = `sticker_cd:${event.platform}:${event.scene}:${event.peerId}`;
  const last = store.getKV(cooldownKey);
  const cooldownMs = config.bot.stickerCooldownMs;
  if (last !== null && Date.now() - Number(last) < cooldownMs) {
    logger.debug('表情包冷却中，跳过', { hint });
    return;
  }

  // hint 期望是图库编号；兼容模型只写数字的写法
  const idMatch = /(\d{2,4})/.exec(hint);
  const pick = idMatch ? stickers.get(idMatch[1] as string) : null;
  if (!pick) {
    logger.debug('模型给的表情包编号无效', { hint });
    return;
  }

  try {
    await sleep(500);
    await adapter.sendImage(event.scene, event.peerId, pick.file);
    store.setKV(cooldownKey, String(Date.now()));
    stats.stickers++;
    logger.info('已发送表情包', { id: pick.id, title: pick.title });

    // 必须把自己发的图记进记忆库。
    // 不记的话，模型在上下文里只看到用户消息 + 自己上一轮的文字，
    // 会误以为这张图是【用户】发的——实测在真群里造成
    // 「反问用户从哪找的图」「贼喊捉贼」这种逻辑崩坏。
    store.appendMessage(event.platform, {
      scene: event.scene,
      peerId: event.peerId,
      userId: botName,
      nickname: botName,
      text: `（发了张表情包：${pick.title || pick.id}）`,
      mentionsBot: false,
      fromSelf: true,
      timestamp: Math.floor(Date.now() / 1000),
    });
  } catch (error) {
    logger.warn('表情包发送失败', { id: pick.id, message: (error as Error).message });
  }
}

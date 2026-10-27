/**
 * 图片收集：消息图 + 引用图 + 卡片封面。
 *
 * 从 pipeline.ts 抽出来的纯函数。三路来源的优先级是有意设计的：
 * 用户直接发的图 > 被引用的图 > 卡片封面。
 */

import type { MessageEvent } from '../types.js';
import type { Logger } from '../logger.js';
import { fetchImageAsDataUrl } from '../image.js';
import type { PipelineContext } from './context.js';

/**
 * 把消息里所有可用的图片下载并转成 data URL。
 *
 * 三路来源：
 *   1. 本条消息的 image 段
 *   2. 被引用消息里的图片（用户引用一张图问"这是啥"）
 *   3. 分享卡片的封面图（小红书这类正文被风控挡住时的唯一画面信息）
 *
 * 三者共用 vision.maxImages 上限。顺序即优先级。
 */
export async function collectImages(
  ctx: PipelineContext,
  event: MessageEvent,
  logger: Logger,
): Promise<string[]> {
  const { config } = ctx;
  if (!config.vision.enabled) return [];

  // 1) 消息里直接带的图片
  const urls = event.segments
    .filter((s): s is { type: 'image'; url?: string; fileId?: string } => s.type === 'image')
    .map((s) => s.url)
    .filter((u): u is string => typeof u === 'string' && u.length > 0);

  // 2) 被引用消息里的图片。
  //    用户引用一条看图消息问"这是啥"时，图在被引用的那条里，不在本条。
  const quotedImages = event.quotedImageUrls ?? [];
  if (quotedImages.length > 0) {
    logger.info('引用的消息带图片，一并识别', { count: quotedImages.length });
  }

  // 3) 分享卡片的封面图。
  //    小红书这类站点正文被风控挡住时，封面是唯一能看到的画面信息。
  const shareCovers = event.segments
    .filter((s): s is Extract<typeof s, { type: 'share' }> => s.type === 'share')
    .map((s) => s.imageUrl)
    .filter((u): u is string => typeof u === 'string' && u.length > 0);
  if (shareCovers.length > 0) {
    logger.info('分享卡片带封面图，一并识别', { count: shareCovers.length });
  }

  const all = [...urls, ...quotedImages, ...shareCovers].slice(0, config.vision.maxImages);
  if (all.length === 0) return [];

  logger.info('发现图片，准备识别', { count: all.length });
  const results = await Promise.all(all.map((u) => fetchImageAsDataUrl(u)));
  const ok = results.filter((r): r is string => r !== null);
  if (ok.length === 0) {
    logger.warn('图片全部处理失败，按纯文本回复');
  }
  return ok;
}

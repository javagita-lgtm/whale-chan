/**
 * 图片获取：把消息里的图片引用转成模型可用的 data URL。
 *
 * 为什么不用直接把 URL 丢给模型：
 *   - QQ 图片 CDN 链接会过期，且不少带防盗链，模型侧拉不到；
 *   - 先下载转 base64 是最稳的做法，代价是多一次网络往返。
 *
 * 同时做体积控制：超过阈值就压缩，避免 prompt 过大导致费用飙升或请求被拒。
 */

import sharp from 'sharp';
import { createLogger } from './logger.js';

const logger = createLogger('image');

/** 单张图送进模型前的最大边长；再大对识别没帮助，只烧 token。 */
const MAX_EDGE = 768;
/** 压缩后 JPEG 质量。 */
const JPEG_QUALITY = 80;
/** 原图下载上限，超过直接放弃（防止意外拉一个几十 MB 的大图）。 */
const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;
/** 下载超时。 */
const DOWNLOAD_TIMEOUT_MS = 15_000;

/**
 * 下载图片并转成 data URL。
 * @returns data URL；失败返回 null（调用方降级为「[图片]」占位）
 */
export async function fetchImageAsDataUrl(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        // 部分 CDN 对无 UA 的请求直接拒绝
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        Accept: 'image/*,*/*;q=0.8',
      },
    });
    if (!res.ok) {
      logger.warn('图片下载失败', { status: res.status });
      return null;
    }

    const length = Number(res.headers.get('content-length') ?? '0');
    if (length > MAX_DOWNLOAD_BYTES) {
      logger.warn('图片过大，跳过识别', { bytes: length });
      return null;
    }

    const raw = Buffer.from(await res.arrayBuffer());
    if (raw.length > MAX_DOWNLOAD_BYTES) {
      logger.warn('图片过大，跳过识别', { bytes: raw.length });
      return null;
    }

    // 统一转成 JPEG，兼顾体积与兼容性（webp/gif 部分上游不支持）
    const jpeg = await sharp(raw)
      .resize(MAX_EDGE, MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();

    logger.debug('图片已就绪', {
      originalBytes: raw.length,
      jpegBytes: jpeg.length,
    });
    return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  } catch (error) {
    const msg = (error as Error).name === 'AbortError' ? '下载超时' : (error as Error).message;
    logger.warn('图片处理失败', { message: msg });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

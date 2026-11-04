/**
 * Gemini 生图客户端：走本地适配层（5052）。
 *
 * 为什么不直接调 gemini_webapi：那是 async Python 库，Node 侧调不了。
 * 适配层已经在跑（scripts/gemini_server.py），这里只做 HTTP 调用。
 *
 * 优势（相对豆包 + LaMa）：
 *   - 出图显存 ~0（纯 HTTP，云端算力）
 *   - 不需要去水印（Gemini 无可见 logo，只有 SynthID 隐形水印）
 *   - 1408x768 照片级质量
 *
 * 代价：
 *   - 必须走代理（实测直连 HTTP 000）
 *   - 依赖 gemini_webapi 的 cookie 有效（约 400 天有效期，可自动刷新）
 *   - 单张 30~45 秒
 */

import type { Logger } from './logger.js';

export interface GeminiPainterOptions {
  logger: Logger;
  /** 适配层地址，如 http://127.0.0.1:5052 */
  baseUrl: string;
  /** 单张超时 */
  timeoutMs: number;
  /** 是否启用 */
  enabled: boolean;
}

export interface GeminiResult {
  filePath: string;
  elapsedMs: number;
}

interface PaintResponse {
  ok?: boolean;
  path?: string;
  durationSec?: number;
  text?: string;
  message?: string;
}

export class GeminiPainter {
  private queue: Promise<unknown> = Promise.resolve();
  private busy = false;

  constructor(private readonly options: GeminiPainterOptions) {}

  get isBusy(): boolean {
    return this.busy;
  }

  /** 探活：适配层 + cookie 是否就绪。 */
  async ping(): Promise<boolean> {
    const { baseUrl, logger } = this.options;
    try {
      const res = await fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return false;
      const j = (await res.json()) as { ok?: boolean; hasCookie?: boolean };
      const ok = j.ok === true && j.hasCookie === true;
      if (!ok) {
        logger.info('Gemini 适配层在跑但没 cookie', { hasCookie: j.hasCookie });
      }
      return ok;
    } catch {
      logger.info('Gemini 适配层未响应', { baseUrl });
      return false;
    }
  }

  /** 出图。内部串行化（Gemini 网页版并发会互相干扰）。 */
  async paint(prompt: string, refImage?: string): Promise<GeminiResult | null> {
    if (!this.options.enabled) return null;

    const task = this.queue.then(() => this.doPaint(prompt, refImage));
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async doPaint(prompt: string, refImage?: string): Promise<GeminiResult | null> {
    const { logger, baseUrl, timeoutMs } = this.options;
    const startedAt = Date.now();
    this.busy = true;

    try {
      const payload: Record<string, string> = { prompt };
      if (refImage) payload['ref'] = refImage;

      const res = await fetch(`${baseUrl}/paint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });

      const j = (await res.json()) as PaintResponse;

      if (!res.ok || j.ok !== true || !j.path) {
        logger.info('Gemini 出图失败', {
          status: res.status,
          message: (j.message ?? '').slice(0, 150),
        });
        return null;
      }

      const elapsedMs = Date.now() - startedAt;
      logger.info('Gemini 出图完成', {
        file: j.path.split('/').pop(),
        seconds: Math.round(elapsedMs / 100) / 10,
        // 注意：这里不算"去水印"，因为 Gemini 本来就没有可见水印
        watermark: 'none',
      });

      return { filePath: j.path, elapsedMs };
    } catch (error) {
      logger.info('Gemini 出图异常', {
        message: (error as Error).message.slice(0, 150),
      });
      return null;
    } finally {
      this.busy = false;
    }
  }
}

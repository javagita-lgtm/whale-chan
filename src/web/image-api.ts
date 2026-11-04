/**
 * 生图 API：给本地 Web 面板和外部调用提供画图入口。
 *
 * 为什么单独一个文件：
 *   control-api.ts 已经 450 行，管的是进程与状态；
 *   生图是内容生产，逻辑独立，分开放更好维护。
 *
 * 接口：
 *   POST /api/image/generate   { prompt, size?, style?, model? }
 *   GET  /api/image/history    最近的生成记录
 *   POST /api/image/free       释放显存
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ComfyClient } from '../core/comfy.js';
import { createLogger } from '../core/logger.js';
import {
  MODEL_PRESETS,
  resolveSizeForPreset,
  type ModelPreset,
} from '../core/image-gen.js';
import { composeNegative, composePrompt, detectStyle } from '../core/prompt-translate.js';

const logger = createLogger('web-image');

/** 最近生成记录（仅内存，够面板用）。 */
interface HistoryItem {
  at: string;
  prompt: string;
  checkpoint: string;
  width: number;
  height: number;
  filename: string;
  elapsedMs: number;
}

const history: HistoryItem[] = [];
const HISTORY_MAX = 30;

function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 从 .env 读取生图配置。 */
function readImageConfig(root: string): {
  enabled: boolean;
  baseUrl: string;
  outputDir: string;
  checkpoint: string;
  timeoutMs: number;
} {
  const out = {
    enabled: false,
    baseUrl: 'http://127.0.0.1:8188',
    outputDir: 'E:\\comfyUI\\output',
    checkpoint: 'dreamshaper_8.safetensors',
    timeoutMs: 120_000,
  };
  const f = join(root, '.env');
  if (!existsSync(f)) return out;
  try {
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (!m) continue;
      const k = m[1] ?? '';
      const v = m[2] ?? '';
      if (k === 'IMAGE_GEN_ENABLED') out.enabled = v.trim() === 'true';
      else if (k === 'IMAGE_BASE_URL') out.baseUrl = v.trim();
      else if (k === 'COMFY_OUTPUT_DIR') out.outputDir = v.trim();
      else if (k === 'IMAGE_CHECKPOINT') out.checkpoint = v.trim();
      else if (k === 'IMAGE_TIMEOUT_MS') out.timeoutMs = Number(v.trim()) || out.timeoutMs;
    }
  } catch {
    /* 用默认值 */
  }
  return out;
}

/**
 * 面板生图不需要 LLM 翻译：用户直接写提示词。
 * 但如果输入是中文，仍然要转成 tag。
 *
 * @param userNegative 用户填的额外负向词（追加到默认词后面，不是替换）
 */
async function toPrompt(
  text: string,
  styleInput: string,
  userNegative?: string,
): Promise<{ positive: string; negative: string } | null> {
  const isAscii = /^[\x20-\x7E,()\[\]\-_.:]+$/.test(text);
  const style =
    styleInput === 'realistic' ? 'realistic' : styleInput === 'auto' ? 'auto' : detectStyle(text);

  // 已是英文 tag：直接用，只补构图光影（不经过 LLM，所以不受安全策略影响）
  if (isAscii && text.split(',').length >= 2) {
    const base = /masterpiece/i.test(text) ? text : `masterpiece, best quality, ${text}`;
    return {
      positive: composePrompt(base, style as never),
      negative: composeNegative(style as never, userNegative),
    };
  }

  // 中文：调 LLM 翻译
  const { LlmClient } = await import('../core/llm.js');
  const { loadConfig } = await import('../config.js');
  const { translateToPrompt } = await import('../core/prompt-translate.js');
  const cfg = loadConfig();
  const llm = new LlmClient(cfg.llm, createLogger('web-llm'));
  const r = await translateToPrompt(text, llm, logger);
  if (!r) return null;

  // translateToPrompt 内部已经拼过默认负向词，这里把用户词追加到后面
  const negative = userNegative
    ? `${r.negative}, ${userNegative}`
    : r.negative;
  return { positive: r.positive, negative };
}

/** 选模型：允许请求显式指定，否则按尺寸/关键词推断。 */
function pickByRequest(model: string | undefined, text: string, width: number): ModelPreset {
  if (model === 'sd15') return MODEL_PRESETS.sd15;
  if (model === 'sdxl') return MODEL_PRESETS.sdxl_anime;
  // 大尺寸或点名角色时倾向 SDXL
  if (width >= 768 || /(高清|大图|角色)/.test(text)) return MODEL_PRESETS.sdxl_anime;
  return MODEL_PRESETS.sd15;
}

export async function handleImageApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  root: string,
): Promise<boolean> {
  const cfg = readImageConfig(root);

  // ---- 生成 ----
  if (req.method === 'POST' && url.pathname === '/api/image/generate') {
    if (!cfg.enabled) {
      json(res, 400, { ok: false, error: '生图未启用（IMAGE_GEN_ENABLED=false）' });
      return true;
    }

    let body: {
      prompt?: string;
      size?: number;
      style?: string;
      model?: string;
      seed?: number;
      steps?: number;
      cfg?: number;
      negative?: string;
      /**
       * 原始模式：prompt 原样送给 ComfyUI。
       * 不翻译、不加画风/构图词、不做内容过滤。
       */
      rawPrompt?: boolean;
      /** 放大模型文件名；不填则不放大 */
      upscaleModel?: string;
      /** 放大后缩到的边长；不填保持 4x 原始尺寸 */
      upscaleTo?: number;
    };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      json(res, 400, { ok: false, error: '请求格式错误' });
      return true;
    }

    const text = (body.prompt ?? '').trim();
    if (text.length === 0) {
      json(res, 400, { ok: false, error: '提示词不能为空' });
      return true;
    }

    const comfy = new ComfyClient({
      baseUrl: cfg.baseUrl,
      outputDir: cfg.outputDir,
      defaultCheckpoint: cfg.checkpoint,
      logger,
    });

    if (!(await comfy.ping())) {
      json(res, 503, { ok: false, error: 'ComfyUI 未响应（8188），可能未启动' });
      return true;
    }

    try {
      const rawMode = body.rawPrompt === true;

      // 原始模式：原样透传，不翻译、不加画风词、不过滤
      const p = rawMode
        ? {
            positive: text,
            // 原始模式下 negative 是「完全替换」
            negative:
              body.negative ??
              'worst quality, low quality, lowres, bad anatomy, bad hands, ' +
                'extra fingers, watermark, text, signature, jpeg artifacts',
          }
        : await toPrompt(
            text,
            body.style ?? 'anime',
            // 自动模式下 negative 是「追加」到默认负向词后面
            body.negative,
          );

      if (!p) {
        // 翻译失败/被模型拒绝：给明确提示，不要拿空提示词去糊弄模型
        json(res, 400, {
          ok: false,
          error:
            '提示词翻译失败：模型拒绝了这次请求。' +
            '如果涉及未成年设定角色，换个成年角色或改用原始提示词直通。',
          hint: '勾选「原始提示词直通」那栏直接写英文 tag，不经过 LLM（如 1girl, tohsaka rin, white thighhighs）',
        });
        return true;
      }
      const preset = pickByRequest(body.model, text, body.size ?? 512);
      const size = resolveSizeForPreset(text, body.size ?? preset.baseSize);

      // 放大模型只允许白名单，防止传任意路径
      const ALLOWED_UPSCALERS = ['4x-UltraSharp.pth', 'RealESRGAN_x4plus_anime_6B.pth'];
      const upscaler =
        body.upscaleModel && ALLOWED_UPSCALERS.includes(body.upscaleModel)
          ? body.upscaleModel
          : undefined;

      const t0 = Date.now();
      const r = await comfy.generate({
        prompt: p.positive,
        negative: body.negative ?? p.negative,
        checkpoint: preset.checkpoint,
        vPred: preset.vPred,
        width: size.width,
        height: size.height,
        steps: body.steps ?? preset.steps,
        cfg: body.cfg ?? preset.cfg,
        sampler: preset.sampler,
        scheduler: preset.scheduler,
        seed: body.seed,
        upscaleModel: upscaler,
        upscaleTo: body.upscaleTo,
        timeoutMs: cfg.timeoutMs,
      });

      if (!r) {
        json(res, 500, { ok: false, error: '生成失败或超时' });
        return true;
      }

      const elapsedMs = Date.now() - t0;
      // 放大后的实际输出尺寸（4x 就是 base*4，缩放过就是 upscaleTo）
      const outWidth = upscaler ? (body.upscaleTo && body.upscaleTo > 0 ? body.upscaleTo : size.width * 4) : size.width;
      const outHeight = upscaler ? (body.upscaleTo && body.upscaleTo > 0 ? body.upscaleTo : size.height * 4) : size.height;

      history.unshift({
        at: new Date().toISOString(),
        prompt: text,
        checkpoint: preset.checkpoint,
        width: outWidth,
        height: outHeight,
        filename: r.filename,
        elapsedMs,
      });
      if (history.length > HISTORY_MAX) history.pop();

      logger.info('面板出图', {
        file: r.filename,
        elapsedMs,
        size: `${outWidth}x${outHeight}`,
        upscaler: upscaler ?? null,
      });

      json(res, 200, {
        ok: true,
        filename: r.filename,
        // 前端用这个地址预览
        url: `/api/image/file?name=${encodeURIComponent(r.filename)}`,
        usedPrompt: p.positive,
        negative: p.negative,
        checkpoint: preset.checkpoint,
        width: outWidth,
        height: outHeight,
        baseSize: `${size.width}x${size.height}`,
        upscaled: Boolean(upscaler),
        upscaleModel: upscaler ?? null,
        rawMode,
        elapsedMs,
      });
    } catch (e) {
      json(res, 500, { ok: false, error: (e as Error).message.slice(0, 200) });
    }
    return true;
  }

  // ---- 取图 ----
  if (req.method === 'GET' && url.pathname === '/api/image/file') {
    const name = url.searchParams.get('name') ?? '';
    // 防目录穿越：只允许纯文件名
    if (!/^[\w.-]+\.(png|jpg|jpeg|webp)$/i.test(name)) {
      json(res, 400, { ok: false, error: '非法文件名' });
      return true;
    }
    const f = join(cfg.outputDir, name);
    if (!existsSync(f)) {
      json(res, 404, { ok: false, error: '文件不存在' });
      return true;
    }
    const data = readFileSync(f);
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(data);
    return true;
  }

  // ---- 历史 ----
  if (req.method === 'GET' && url.pathname === '/api/image/history') {
    json(res, 200, { ok: true, items: history });
    return true;
  }

  // ---- 画廊：列出输出目录里所有图片（按时间倒序，支持分页）----
  if (req.method === 'GET' && url.pathname === '/api/image/gallery') {
    const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
    const size = Math.min(200, Math.max(1, Number(url.searchParams.get('size') ?? '60') || 60));
    const since = url.searchParams.get('since'); // 可选：只看这个时间之后的

    let files: Array<{ name: string; size: number; mtime: number }> = [];
    try {
      const dirents = readdirSync(cfg.outputDir);
      for (const f of dirents) {
        if (!/\.(png|jpe?g|webp)$/i.test(f)) continue;
        try {
          const st = statSync(join(cfg.outputDir, f));
          if (since && st.mtimeMs < Number(since)) continue;
          files.push({ name: f, size: st.size, mtime: st.mtimeMs });
        } catch {
          /* 单个文件读失败就跳过 */
        }
      }
    } catch {
      json(res, 200, { ok: true, total: 0, page, size, items: [], outputDir: cfg.outputDir });
      return true;
    }

    // 文件名里的数字序号大的通常更新，但以 mtime 为准更可靠
    files.sort((a, b) => b.mtime - a.mtime);
    const total = files.length;
    const start = (page - 1) * size;
    const items = files.slice(start, start + size).map((f) => ({
      name: f.name,
      sizeKB: Math.round((f.size / 1024) * 10) / 10,
      at: new Date(f.mtime).toISOString(),
      url: `/api/image/file?name=${encodeURIComponent(f.name)}`,
    }));

    json(res, 200, {
      ok: true,
      total,
      page,
      size,
      pages: Math.ceil(total / size),
      outputDir: cfg.outputDir,
      items,
    });
    return true;
  }

  // ---- 释放显存 ----
  if (req.method === 'POST' && url.pathname === '/api/image/free') {
    const comfy = new ComfyClient({ baseUrl: cfg.baseUrl, logger });
    const ok = await comfy.free(true);
    json(res, ok ? 200 : 500, { ok, message: ok ? '已释放显存' : '释放失败' });
    return true;
  }

  // ---- 磁盘统计（给面板显示）----
  if (req.method === 'GET' && url.pathname === '/api/image/stats') {
    let count = 0;
    let totalBytes = 0;
    try {
      const files = readdirSync(cfg.outputDir);
      for (const f of files) {
        if (!/\.(png|jpe?g|webp)$/i.test(f)) continue;
        count++;
        totalBytes += statSync(join(cfg.outputDir, f)).size;
      }
    } catch {
      /* 目录不存在 */
    }
    json(res, 200, {
      ok: true,
      enabled: cfg.enabled,
      outputDir: cfg.outputDir,
      count,
      totalMB: Math.round((totalBytes / 1024 / 1024) * 10) / 10,
    });
    return true;
  }

  return false;
}

/** 供测试用：清空内存历史。 */
export function __clearHistory(): void {
  history.length = 0;
}

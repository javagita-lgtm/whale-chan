/**
 * ComfyUI 文生图客户端。
 *
 * 只依赖 ComfyUI 的 HTTP API：
 *   POST /prompt    提交工作流
 *   GET  /history   查询结果
 *   GET  /view      下载图片
 *   POST /free      卸载模型释放显存
 *
 * 设计要点：
 *   - 工作流用固定 JSON 模板，只替换提示词/尺寸/步数等少量字段
 *   - 轮询而不是 WebSocket（简单、够用）
 *   - 超时/失败抛错，由调用方决定降级
 */

import type { Logger } from './logger.js';

export interface GenerateOptions {
  /** 正向提示词（英文 Danbooru tag 或自然语言） */
  prompt: string;
  /** 负向提示词 */
  negative?: string;
  /** 宽高，默认 512×512 */
  width?: number;
  height?: number;
  /** 采样步数 */
  steps?: number;
  /** CFG */
  cfg?: number;
  /** 采样器 */
  sampler?: string;
  /** 调度器 */
  scheduler?: string;
  /** 随机种子，-1 表示随机 */
  seed?: number;
  /** checkpoint 文件名 */
  checkpoint?: string;
  /**
   * 是否为 v-prediction 模型（如 NoobAI-XL Vpred）。
   * 开启后会插入 ModelSamplingDiscrete 节点；不开会出纯色块。
   */
  vPred?: boolean;
  /**
   * 放大模型文件名（upscale_models 目录下）。
   *
   * 为什么用放大而不是直接画大图：
   *   实测 SDXL 在 8GB 上 1216 是可用上限，1280 会因为爆显存降级到 274 秒（8 倍慢），
   *   1536 直接失败。而 1024 出图后再放大 4 倍到 4096，细节是真正增加的，
   *   放大模型只占几百 MB 显存。
   */
  upscaleModel?: string;
  /** 放大后再缩到这个边长（不填则保持放大后的原始尺寸） */
  upscaleTo?: number;
  /** 超时毫秒 */
  timeoutMs?: number;
}

export interface GenerateResult {
  /** 生成的文件名（在 ComfyUI output 目录下） */
  filename: string;
  /** 子目录（通常是空） */
  subfolder: string;
  /** 类型（output） */
  type: string;
  /** 本地绝对路径 */
  localPath?: string;
  /** 耗时毫秒 */
  elapsedMs: number;
}

export interface ComfyClientOptions {
  /** ComfyUI 地址，默认 http://127.0.0.1:8188 */
  baseUrl?: string;
  /** ComfyUI 的输出目录（用于转成本地路径直接发图） */
  outputDir?: string;
  /** 默认 checkpoint */
  defaultCheckpoint?: string;
  logger: Logger;
}

/** ComfyUI 节点图（API 格式）。 */
interface WorkflowNode {
  class_type: string;
  inputs: Record<string, unknown>;
}

export class ComfyClient {
  private readonly baseUrl: string;
  private readonly outputDir: string;
  private readonly defaultCheckpoint: string;
  private clientId: string;

  constructor(private readonly options: ComfyClientOptions) {
    this.baseUrl = (options.baseUrl ?? 'http://127.0.0.1:8188').replace(/\/+$/, '');
    this.outputDir = options.outputDir ?? '';
    this.defaultCheckpoint = options.defaultCheckpoint ?? 'dreamshaper_8.safetensors';
    this.clientId = `whale-chan-${Date.now().toString(36)}`;
  }

  /** 服务是否在线。 */
  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/system_stats`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** 查询服务与显存状态。 */
  async stats(): Promise<{
    version?: string;
    gpu?: string;
    vramTotalMB?: number;
    vramFreeMB?: number;
  } | null> {
    try {
      const res = await fetch(`${this.baseUrl}/system_stats`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      const j = (await res.json()) as {
        system?: { comfyui_version?: string };
        devices?: Array<{ name?: string; vram_total?: number; vram_free?: number }>;
      };
      const d = j.devices?.[0];
      return {
        version: j.system?.comfyui_version,
        gpu: d?.name,
        vramTotalMB: d?.vram_total ? Math.round(d.vram_total / 1024 / 1024) : undefined,
        vramFreeMB: d?.vram_free ? Math.round(d.vram_free / 1024 / 1024) : undefined,
      };
    } catch {
      return null;
    }
  }

  /**
   * 生成图片。
   *
   * 流程：提交 → 轮询 history → 返回文件名。
   */
  async generate(opts: GenerateOptions): Promise<GenerateResult | null> {
    const startedAt = Date.now();
    const timeoutMs = opts.timeoutMs ?? 120_000;

    const workflow = this.buildWorkflow(opts);

    let promptId: string;
    try {
      const res = await fetch(`${this.baseUrl}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: workflow, client_id: this.clientId }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        this.options.logger.info('ComfyUI 提交失败', {
          status: res.status,
          detail: text.slice(0, 300),
        });
        return null;
      }
      const j = (await res.json()) as { prompt_id?: string; error?: unknown };
      if (!j.prompt_id) {
        this.options.logger.info('ComfyUI 未返回 prompt_id', { detail: JSON.stringify(j).slice(0, 200) });
        return null;
      }
      promptId = j.prompt_id;
    } catch (error) {
      this.options.logger.info('ComfyUI 提交异常', {
        message: (error as Error).message.slice(0, 150),
      });
      return null;
    }

    // 轮询结果
    const deadline = Date.now() + timeoutMs;
    let pollDelay = 500;
    while (Date.now() < deadline) {
      await sleep(pollDelay);
      pollDelay = Math.min(2000, pollDelay + 250);

      try {
        const res = await fetch(`${this.baseUrl}/history/${promptId}`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) continue;
        const j = (await res.json()) as Record<
          string,
          {
            outputs?: Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }> }>;
            status?: { completed?: boolean; status_str?: string };
          }
        >;
        const entry = j[promptId];
        if (!entry) continue;

        if (entry.status?.status_str === 'error') {
          this.options.logger.info('ComfyUI 生成出错', { promptId });
          return null;
        }

        const images = Object.values(entry.outputs ?? {})
          .flatMap((o) => o.images ?? [])
          .filter((im) => im.type === 'output');
        if (images.length === 0) continue;

        const first = images[0] as { filename: string; subfolder: string; type: string };
        const elapsedMs = Date.now() - startedAt;
        const localPath = this.outputDir
          ? joinPath(this.outputDir, first.subfolder, first.filename)
          : undefined;

        this.options.logger.info('ComfyUI 生成完成', {
          filename: first.filename,
          elapsedMs,
          size: `${opts.width ?? 512}x${opts.height ?? 512}`,
        });

        return {
          filename: first.filename,
          subfolder: first.subfolder,
          type: first.type,
          localPath,
          elapsedMs,
        };
      } catch {
        // 单次查询失败继续等
      }
    }

    this.options.logger.info('ComfyUI 生成超时', { promptId, timeoutMs });
    return null;
  }

  /** 卸载模型、释放显存（服务保持运行）。 */
  async free(unloadModels = true): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/free`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unload_models: unloadModels, free_memory: true }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        this.options.logger.info('已请求 ComfyUI 释放显存', { unloadModels });
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /** 下载生成的图片字节。 */
  async fetchImage(result: GenerateResult): Promise<Buffer | null> {
    const q = new URLSearchParams({
      filename: result.filename,
      subfolder: result.subfolder,
      type: result.type,
    });
    try {
      const res = await fetch(`${this.baseUrl}/view?${q.toString()}`, {
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    } catch {
      return null;
    }
  }

  /**
   * 构造文生图工作流。
   *
   * 节点编号：
   *   3=KSampler, 4=CheckpointLoader, 5=EmptyLatent,
   *   6/7=CLIP编码, 8=VAEDecode, 9=SaveImage,
   *   10=ModelSamplingDiscrete（仅 v-pred 模型需要）
   *
   * v-pred 说明：
   *   NoobAI-XL 的 v-pred 变体必须在采样前插入 ModelSamplingDiscrete
   *   并把 sampling 设为 v_prediction，否则出图是纯色块（实测为黄色剪影）。
   *   同时 v-pred 不能用 karras 调度器，要用 normal，且 CFG 要低（4~5）。
   */
  private buildWorkflow(opts: GenerateOptions): Record<string, WorkflowNode> {
    const width = opts.width ?? 512;
    const height = opts.height ?? 512;
    // 种子固定为随机值，避免 ComfyUI 复用缓存
    const seed = opts.seed !== undefined && opts.seed >= 0 ? opts.seed : Math.floor(Math.random() * 2 ** 32);

    const workflow: Record<string, WorkflowNode> = {
      '3': {
        class_type: 'KSampler',
        inputs: {
          seed,
          steps: opts.steps ?? 25,
          cfg: opts.cfg ?? 7,
          sampler_name: opts.sampler ?? 'dpmpp_2m',
          scheduler: opts.scheduler ?? 'karras',
          denoise: 1,
          // v-pred 时要指向 ModelSamplingDiscrete 的输出
          model: opts.vPred ? ['10', 0] : ['4', 0],
          positive: ['6', 0],
          negative: ['7', 0],
          latent_image: ['5', 0],
        },
      },
      '4': {
        class_type: 'CheckpointLoaderSimple',
        inputs: { ckpt_name: opts.checkpoint ?? this.defaultCheckpoint },
      },
      '5': {
        class_type: 'EmptyLatentImage',
        inputs: { width, height, batch_size: 1 },
      },
      '6': {
        class_type: 'CLIPTextEncode',
        inputs: { text: opts.prompt, clip: ['4', 1] },
      },
      '7': {
        class_type: 'CLIPTextEncode',
        inputs: {
          text:
            opts.negative ??
            'worst quality, low quality, normal quality, lowres, bad anatomy, bad hands, extra fingers, watermark, text, signature',
          clip: ['4', 1],
        },
      },
      '8': {
        class_type: 'VAEDecode',
        inputs: { samples: ['3', 0], vae: ['4', 2] },
      },
      '9': {
        class_type: 'SaveImage',
        inputs: { filename_prefix: 'whale', images: ['8', 0] },
      },
    };

    if (opts.vPred) {
      workflow['10'] = {
        class_type: 'ModelSamplingDiscrete',
        inputs: {
          model: ['4', 0],
          sampling: 'v_prediction',
          zsnr: false,
        },
      };
    }

    // 放大链路：VAEDecode → UpscaleModelLoader → ImageUpscaleWithModel → (可选 ImageScale) → SaveImage
    //
    // 只在要求放大时才加节点，避免普通出图多跑一遍推理。
    if (opts.upscaleModel && opts.upscaleModel.length > 0) {
      workflow['11'] = {
        class_type: 'UpscaleModelLoader',
        inputs: { model_name: opts.upscaleModel },
      };
      workflow['12'] = {
        class_type: 'ImageUpscaleWithModel',
        inputs: { upscale_model: ['11', 0], image: ['8', 0] },
      };

      // 4x 放大后可能过大（1024 → 4096），按需缩回指定边长
      if (opts.upscaleTo && opts.upscaleTo > 0) {
        workflow['13'] = {
          class_type: 'ImageScale',
          inputs: {
            image: ['12', 0],
            upscale_method: 'lanczos',
            width: opts.upscaleTo,
            height: opts.upscaleTo,
            crop: 'disabled',
          },
        };
        workflow['9'] = {
          class_type: 'SaveImage',
          inputs: { filename_prefix: 'whale', images: ['13', 0] },
        };
      } else {
        workflow['9'] = {
          class_type: 'SaveImage',
          inputs: { filename_prefix: 'whale', images: ['12', 0] },
        };
      }
    }

    return workflow;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function joinPath(...parts: string[]): string {
  return parts
    .filter((p) => p && p.length > 0)
    .join('\\')
    .replace(/[\\/]+/g, '\\');
}

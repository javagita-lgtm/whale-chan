/**
 * 群聊生图：把「画个xxx」变成一张图。
 *
 * 链路：
 *   用户中文需求
 *     → LLM 翻成英文 Danbooru tag（模型只认这些）
 *     → ComfyUI 生成
 *     → 读本地文件发到群里
 *
 * 三层保护：
 *   1. 触发词：不是所有消息都要画图
 *   2. 内容过滤：群聊场景下拦截明显 NSFW
 *   3. 并发排队：8GB 显存同时只能跑一张
 */

import type { Logger } from './logger.js';
import type { LlmClient } from './llm.js';
import type { ComfyClient, GenerateResult } from './comfy.js';
import type { GeminiPainter } from './gemini.js';
import { translateToPrompt } from './prompt-translate.js';
import { constraintsForRefs } from './ref-constraints.js';

/**
 * 模型预设。
 *
 * 为什么需要：SD1.5 和 SDXL v-pred 的采样参数完全不同，
 * 用错参数会出纯色块（实测 NoobAI v-pred 用 karras 出黄色剪影）。
 */
export interface ModelPreset {
  /** checkpoint 文件名 */
  checkpoint: string;
  /** 是否为 v-pred 模型 */
  vPred: boolean;
  /** 原生分辨率（短边） */
  baseSize: number;
  /** 宽高比上限（SDXL 建议 1.5 以内） */
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
}

export const MODEL_PRESETS: Record<'sd15' | 'sdxl_anime', ModelPreset> = {
  sd15: {
    checkpoint: 'dreamshaper_8.safetensors',
    vPred: false,
    baseSize: 512,
    steps: 25,
    cfg: 7,
    sampler: 'dpmpp_2m',
    scheduler: 'karras',
  },
  sdxl_anime: {
    checkpoint: 'NoobAI-XL-Vpred-v1.0.safetensors',
    vPred: true,
    baseSize: 832,
    // 实测：cfg5 + euler + normal 是 NoobAI v-pred 在 8GB 上的最佳组合
    // cfg 高了色彩过饱和（头发变橙红），euler_ancestral 也会偏色
    steps: 28,
    cfg: 5,
    sampler: 'euler',
    scheduler: 'normal',
  },
};

/**
 * 按场景选模型。
 *
 * 【2026-10-23 改动】默认全部走 SDXL 二次元模型。
 *
 * 原先是「日常用 SD1.5、点名角色/要高清才用 SDXL」，
 * 但实测群里发「画一张二次元的saber穿着OL装的下班打卡图」时，
 * 因为句子里没有「saber (」这种括号写法、也没有「高清」，
 * 被判成日常需求走了 dreamshaper_8 —— 出来是写实 3D 脸，完全不是二次元。
 *
 * 这个机器人的人设就是二次元鲸鱼娘，用户要的默认也是二次元。
 * 所以改成：默认 SDXL；只有明确要求「快速/随便画」时才用 SD1.5。
 *
 * 代价：慢一些（832 约 25 秒 vs 512 约 10 秒），但画风正确更重要。
 */
export function pickPreset(text: string, isPrivate: boolean): ModelPreset {
  // 明确要求速度优先时才降级到 SD1.5
  const wantsFast = /(快速|快点|随便画|草稿|预览|测试|不用太好)/.test(text);
  if (wantsFast) return MODEL_PRESETS.sd15;

  // 其余一律 SDXL（二次元）
  // isPrivate 参数保留是为了兼容既有调用方与测试，不再影响模型选择
  void isPrivate;
  return MODEL_PRESETS.sdxl_anime;
}

/** 生图请求。 */
export interface ImageRequest {
  /** 用户原话 */
  text: string;
  /** 是否私聊（私聊放宽内容限制） */
  isPrivate: boolean;

  /**
   * 参考图路径（可选，最多 3 张）。**目前是预留接口，尚未接通。**
   *
   * ## 现状（2026-11-04）
   *
   * 字段和下游逻辑都写好了，但**没有任何调用方传入**：
   * - `pipeline/sticker-image.ts` 只传了 `text` / `isPrivate`
   * - `tools.ts` 的 `generate_image` 定义了 `reference` 参数，
   *   但 `dispatchIntent` 没往这里传
   *
   * 也就是说，用户发姿势图说「按这个画」时，图**不会**被用到。
   * 这是刻意的——接通需要改动 pipeline 的图收集与传递链路，
   * 而当前硬件（RTX 2070 8GB）跑多图参考意义有限。
   *
   * ## 接通时要做的
   *
   * 1. `sticker-image.ts` 从 `event` 里取图路径，传进来
   * 2. `tools.ts` 的 `reference` 参数经 `dispatchIntent` 透传
   * 3. 确认后端支持多图（Gemini 支持，ComfyUI 需配 IPAdapter）
   *
   * ## 约束词会自动生效
   *
   * 一旦传了 `refImages`，`constraintsForRefs()` 会按 `refKinds`
   * 追加对应约束（不要把线稿辅助线/服装人台画进成图等），
   * 逻辑见 `ref-constraints.ts`，已有单元测试覆盖。
   *
   * 顺序约定（和 Gemini 多图输入对应）：角色 → 服装（无人物的图） → 姿势线稿
   */
  refImages?: string[];

  /**
   * 参考图类型标记，用于自动选约束词。
   *
   * 只有传了 `refImages` 才有意义。不传时默认 `{ hasPose: true }`
   * （因为姿势线稿是最常见的参考类型）。
   */
  refKinds?: {
    hasPose?: boolean;
    hasCostume?: boolean;
    hasFace?: boolean;
    keepOutfit?: boolean;
  };
}

/** 生图结果。 */
export interface ImageReply {
  ok: boolean;
  /** 生成的本地文件路径 */
  filePath?: string;
  /** 失败时的说明（可直接发给用户） */
  message?: string;
  /** 实际使用的英文提示词，便于排查 */
  usedPrompt?: string;
  /** 耗时毫秒 */
  elapsedMs: number;
}

/**
 * 触发词：判断用户是否想要一张图。
 *
 * 只认明确的生成意图。「画风」「画家」这类词不该触发。
 *
 * 量词要覆盖全：一张/一幅/一个/一只/一条/一头/一朵…
 * 实测「画一只蓝色的鲸鱼」曾因为只认「张幅个」而漏掉。
 *
 * 【2026-11-02 修复】`画` + 量词后面必须跟内容：
 *   之前 `画画真有意思` 会被 「画」+「一?」 匹配到（把「画」自身当量词），
 *   现在要求量词后面至少还有一个非标点字符。
 *   注意这条只是**正则兜底**——语义路由（router.ts 的 tool 层）优先，
 *   它能把「画画真有意思」正确判为聊天。
 */
const GEN_PATTERN =
  /(?:画|生成|来)\s*(?:一?[张幅个只条头朵棵座栋间件套])\s*[^\s，。！？,.!?]|(?:画|生成)\s*(?:一下)\s*[^\s，。！？,.!?]/;
const GEN_PATTERN_BARE = /(画|绘制|生成|create|draw)/i;

/** 排除「画风」「画家」「动画」这类误伤。 */
const FALSE_POSITIVE = /(画风|画家|动画|漫画|笔画|油画|国画|插画风格|画面|画质)/;

/**
 * 误伤的精确判定：排除词**紧跟在动词后面**才算误伤，而不是全文出现就否掉。
 *
 * 之前的问题：整句有任何「画面」就返回 false，
 * 导致「画一张……画面以XX为主题」这种长描述被误杀。
 *
 * 现在只认「画风」「画质」「画家」这类动词紧贴名词的组合，
 * 以及「动画」「漫画」「油画」这类本身是其他名词的词。
 */
const FALSE_POSITIVE_STRICT = /(画风|画家|画质|动画|漫画|笔画|油画|国画)/;

/** 尺寸要求：「大图」「高清」「竖图」「横图」。 */
const SIZE_BIG = /(大图|高清|高分辨率|1080|1024|精细|高质量)/;
const SIZE_WIDE = /(横图|横版|宽屏|16[:：]9|横向)/;
const SIZE_TALL = /(竖图|竖版|手机壁纸|9[:：]16|纵向)/;

/** 明显的 NSFW 关键词（群聊场景拦截）。 */
const NSFW_PATTERN =
  /(nsfw|nude|naked|裸|全裸|半裸|色情|性爱|做爱|露出|走光|乳头|阴茎|阴道|射精|口交|肛|(?:强奸|迷奸|轮奸)|血腥|断肢|虐杀|幼女|loli性|炼铜)/i;

/** 从用户话里解析想要的尺寸（基于给定基准边长）。 */
export function resolveSizeForPreset(
  text: string,
  baseSize: number,
): { width: number; height: number } {
  const big = SIZE_BIG.test(text);
  const wide = SIZE_WIDE.test(text);
  const tall = SIZE_TALL.test(text);

  // SDXL 的原生 832 已经够大，不再跳档；SD1.5 遇到「高清」升一档
  const base = baseSize >= 768 ? baseSize : big ? 768 : baseSize;

  if (wide) return { width: Math.round((base * 16) / 9 / 8) * 8, height: base };
  if (tall) return { width: base, height: Math.round((base * 16) / 9 / 8) * 8 };
  return { width: base, height: base };
}

/**
 * 是否应当触发生图。
 */
export function wantsImage(text: string): boolean {
  const t = text.trim();
  if (t.length < 2) return false;

  // 1) 先看有没有明确的生图动作（带量词，如「画一张」「生成一幅」）
  const hasExplicitIntent = GEN_PATTERN.test(t);

  // 2) 有明确动作时，只有当**动词本身**构成误伤词才否掉
  //    （如「画风不错」里的「画风」）。
  //    注意不能因为句子里别处出现「画面」就否掉整个请求——
  //    实测「画一张……画面以XX为主题」就是这样被误杀的。
  if (hasExplicitIntent) {
    // 动词紧跟「风/家/质」才算误伤；「画面」不再作为排除项
    const verbIsNoun = /(画|生成)(风|家|质)/.test(t);
    if (verbIsNoun) return false;
    return true;
  }

  // 3) 没有量词时，允许「画XX」这种口语说法（如「画个猫」已被 GEN_PATTERN 覆盖，
  //    这里兜底「绘制」「draw」这类动词），但要排除「动画」「漫画」等名词
  if (FALSE_POSITIVE_STRICT.test(t)) return false;

  // 「画画真有意思」「画家」「画质」这类：动词后面紧跟「画/风/家/质」的不是生图请求。
  // 实测「画画真有意思」曾被这条兜底误判成生图（「画」+「画」刚好满足 \s*\S）。
  if (/^(?:我)?(?:画|绘制|生成)(?:画|风|家|质)/.test(t)) return false;

  return GEN_PATTERN_BARE.test(t) && /(画|绘制|生成|draw)\s*\S/.test(t);
}

/** 内容是否违规（群聊时要拦截）。 */
export function isNsfw(text: string): boolean {
  return NSFW_PATTERN.test(text);
}

/**
 * 从用户话里解析想要的尺寸（旧版，基于「群聊 512 / 私聊 768」的固定假设）。
 *
 * @deprecated 生成时改用 {@link resolveSizeForPreset}，因为 SD1.5 和 SDXL
 *   的原生分辨率不同，固定 512/768 会让 SDXL 出糊图。保留此导出仅为兼容。
 */
export function resolveSize(text: string, isPrivate: boolean): { width: number; height: number } {
  const base = isPrivate ? 768 : 512;
  return resolveSizeForPreset(text, base);
}

/**
 * 中文需求 → 英文 Danbooru tag。
 *
 * 为什么必须翻译：SD1.5 的文本编码器是在英文 tag 上训练的，
 * 直接喂中文会得到完全不相关的结果。
 *
 * 翻译用一次轻量 LLM 调用（温度低、max_tokens 小）。
 */
const TRANSLATE_SYSTEM = `你是 Stable Diffusion 提示词工程师。把用户的中文画图需求转成英文 Danbooru 风格 tag。

规则：
- 只输出 tag，用英文逗号分隔，不要解释、不要中文、不要 markdown
- 顺序：质量词 → 主体 → 外貌/服装 → 动作/表情 → 场景 → 风格/光影
- 质量词固定开头：masterpiece, best quality
- 数量控制在 20~40 个 tag
- 用户没说的地方不要瞎编细节（比如没说发色就别加 hair color）
- 若需求含具体角色名，保留原名（如 furina \(genshin impact\)）

示例输出：
masterpiece, best quality, 1girl, solo, blue hair, long hair, school uniform, smile, sitting, classroom, soft lighting, depth of field`;

/** 从 LLM 输出里清洗出纯 tag 串。 */
export function sanitizeTags(raw: string): string {
  let t = raw.trim();
  // 去掉 markdown 代码块
  t = t.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '');
  // 去掉常见前缀
  t = t.replace(/^(prompt|tags?|提示词)\s*[:：]\s*/i, '');
  // 只保留第一行（模型有时会补解释）
  const firstLine = t.split(/\r?\n/).find((l) => l.trim().length > 0) ?? t;
  // 去掉中文（保留英文 tag；角色名里的括号说明保留）
  return firstLine
    .replace(/[\u4e00-\u9fa5]/g, '')
    .replace(/\s*,\s*/g, ', ')
    .replace(/,{2,}/g, ',')
    .replace(/^[,\s]+|[,\s]+$/g, '')
    .trim();
}

export interface ImageGeneratorOptions {
  logger: Logger;
  llm: LlmClient;
  comfy: ComfyClient;
  /** 群聊是否允许生图 */
  enabled: boolean;
  /** 是否拦截 NSFW */
  blockNsfw: boolean;
  /** 生成超时 */
  timeoutMs: number;
  /**
   * Gemini 生图（可选）。
   *
   * 为什么优先它：云端算力，显存 ~0，且无可见水印（不需要去水印环节）。
   * 本地 ComfyUI 跑 SDXL 要占 4~5GB，会和 TTS/SVC 抢显卡。
   * 实测 1408x768、22~31 秒/张。
   */
  gemini?: GeminiPainter | null;
  /** 优先用哪个：'gemini' | 'comfy' */
  prefer?: 'gemini' | 'comfy';
}

export class ImageGenerator {
  /** 简单的串行队列：8GB 显存同时只能跑一张，必须排队。 */
  private queue: Promise<unknown> = Promise.resolve();
  private busy = false;

  constructor(private readonly options: ImageGeneratorOptions) {}

  /** 当前是否有任务在跑。 */
  get isBusy(): boolean {
    return this.busy;
  }

  /**
   * 处理一次生图请求。
   * 内部串行化：多个群同时要图时排队执行。
   */
  async handle(req: ImageRequest): Promise<ImageReply> {
    const startedAt = Date.now();
    const { logger } = this.options;

    if (!this.options.enabled) {
      return { ok: false, message: '生图功能没开', elapsedMs: 0 };
    }

    // 内容过滤：群聊拦截，私聊放行
    if (!req.isPrivate && this.options.blockNsfw && isNsfw(req.text)) {
      logger.info('生图请求被内容过滤拦截', { text: req.text.slice(0, 60) });
      return {
        ok: false,
        message: '这个画不了，群里不方便',
        elapsedMs: Date.now() - startedAt,
      };
    }

    // 排队执行
    const task = this.queue.then(() => this.doGenerate(req, startedAt));
    // 让后续任务等这次完成，但不让异常阻断队列
    this.queue = task.catch(() => undefined);
    return task;
  }

  /**
   * 决定用哪条路出图。
   *
   * 优先级：gemini > comfy
   *   - gemini: 显存 ~0 + 无可见水印（最优）
   *   - comfy : 显存 5GB，但可控性最好（seed/LoRA/画风）
   *
   * 失败会自动往下一级回退。
   */
  private backends(): Array<'gemini' | 'comfy'> {
    const { gemini, prefer } = this.options;
    const all: Array<'gemini' | 'comfy'> = [];
    if (gemini && prefer !== 'comfy') all.push('gemini');
    all.push('comfy');
    return all;
  }

  private async doGenerate(req: ImageRequest, startedAt: number): Promise<ImageReply> {
    this.busy = true;
    try {
      for (const backend of this.backends()) {
        if (backend === 'gemini' && this.options.gemini) {
          const r = await this.tryGemini(req, startedAt);
          if (r) return r;
          this.options.logger.info('Gemini 出图失败，尝试下一个后端');
        }
        if (backend === 'comfy') {
          return await this.doGenerateComfy(req, startedAt);
        }
      }
      // 理论上不可达（backends 最后一定是 comfy）
      return await this.doGenerateComfy(req, startedAt);
    } finally {
      this.busy = false;
    }
  }

  /**
   * 走 Gemini 出图。
   *
   * 不做提示词翻译——Gemini 中文理解很好，而且对"图上写字"很准。
   */
  private async tryGemini(req: ImageRequest, startedAt: number): Promise<ImageReply | null> {
    const { gemini, logger } = this.options;
    if (!gemini) return null;

    const desc = req.text.replace(GEN_PATTERN, '').replace(/^[，,：:\s]+/, '').trim();
    let prompt = desc.length > 0 ? desc : req.text;

    // 有参考图时追加约束词。
    //
    // 为什么要这层：多图参考最常见的失败不是画不出，而是「画多了」——
    // 把姿势线稿的关节圆、服装图里的人台一起画进去。
    // 单靠负面词表压不住，必须在正向提示词里明说。
    // 约束内容提炼自 gen-ai-pose-image 的实战经验。
    if (req.refImages && req.refImages.length > 0) {
      const extra = constraintsForRefs(req.refKinds ?? { hasPose: true });
      prompt = `${prompt}\n\n${extra}`;
      logger.info('参考图生图，已追加约束词', {
        refs: req.refImages.length,
        kinds: JSON.stringify(req.refKinds ?? {}),
      });
    }

    logger.info('走 Gemini 生图', { prompt: prompt.slice(0, 60) });
    const result = await gemini.paint(prompt, req.refImages?.[0]);
    if (!result) return null;

    return {
      ok: true,
      filePath: result.filePath,
      usedPrompt: prompt,
      elapsedMs: Date.now() - startedAt,
    };
  }

  /**
   * 走豆包出图。
   *
   * 不做提示词翻译——豆包是中文模型，直接吃中文描述，
   * 而且它对"图上写什么字"的理解比 SD 系好得多。
   */
  private async doGenerateComfy(req: ImageRequest, startedAt: number): Promise<ImageReply> {
    const { logger, llm, comfy, timeoutMs } = this.options;

    try {
      // 1) 翻译成英文 tag（含画风增强）
      const prompt = await this.translate(req.text);
      if (!prompt) {
        return { ok: false, message: '没想好怎么画，换个说法？', elapsedMs: Date.now() - startedAt };
      }

      // 2) 选模型 + 解析尺寸
      const preset = pickPreset(req.text, req.isPrivate);
      const size = resolveSizeForPreset(req.text, preset.baseSize);

      // 3) 生成
      const result: GenerateResult | null = await comfy.generate({
        prompt: prompt.positive,
        negative: prompt.negative,
        checkpoint: preset.checkpoint,
        vPred: preset.vPred,
        width: size.width,
        height: size.height,
        steps: preset.steps,
        cfg: preset.cfg,
        sampler: preset.sampler,
        scheduler: preset.scheduler,
        timeoutMs,
      });

      if (!result) {
        return {
          ok: false,
          message: '图没生成出来，稍后再试',
          usedPrompt: prompt.positive,
          elapsedMs: Date.now() - startedAt,
        };
      }

      // 4) 拿本地路径（直接发文件比重新下载快）
      let filePath = result.localPath;
      if (!filePath) {
        // 没有本地路径就通过 API 下载
        const buf = await comfy.fetchImage(result);
        if (!buf) {
          return {
            ok: false,
            message: '图出来了但读不到，稍后再试',
            usedPrompt: prompt.positive,
            elapsedMs: Date.now() - startedAt,
          };
        }
        const { writeFileSync, mkdirSync } = await import('node:fs');
        const { join } = await import('node:path');
        const dir = join(process.cwd(), 'data', 'generated');
        mkdirSync(dir, { recursive: true });
        filePath = join(dir, result.filename);
        writeFileSync(filePath, buf);
      }

      logger.info('生图完成', {
        file: result.filename,
        size: `${size.width}x${size.height}`,
        elapsedMs: Date.now() - startedAt,
      });

      return {
        ok: true,
        filePath,
        usedPrompt: prompt.positive,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error) {
      logger.info('生图异常', { message: (error as Error).message.slice(0, 150) });
      return {
        ok: false,
        message: '画图的时候出错了',
        elapsedMs: Date.now() - startedAt,
      };
    }
    // busy 由外层 doGenerate 统一管理（它包住豆包和 Comfy 两条路）
  }

  /** 中文 → 英文 tag。失败时返回 null，调用方决定怎么降级。 */
  private async translate(text: string): Promise<{ positive: string; negative: string } | null> {
    // 复用 prompt-translate 里的完整实现（含画风增强）
    const r = await translateToPrompt(text, this.options.llm, this.options.logger);
    if (!r) return null;
    return { positive: r.positive, negative: r.negative };
  }
}

/** 把生图结果包成适合群聊的说明文字。 */
export function buildImageCaption(reply: ImageReply, text: string): string {
  if (!reply.ok) return reply.message ?? '画不出来';
  const sec = (reply.elapsedMs / 1000).toFixed(1);
  // 简短，不喧宾夺主
  if (/大图|高清|1024/.test(text)) return `画好了，${sec} 秒`;
  return '';
}

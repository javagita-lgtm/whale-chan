/**
 * 提示词翻译与画风增强。
 *
 * 单独抽出来，因为它现在有两个职责：
 *   1. 中文 → 英文 Danbooru tag（SD 只认英文 tag）
 *   2. 按模型和场景补充画风词
 *
 * 第二点是实测发现的：用 dreamshaper_8（通用模型）画 saber 时，
 * 即使 tag 里有 "saber (fate)"，出来的也是 3D 写实质感而不是日系动漫。
 * 原因是模型本身的训练偏向，光靠提示词改不回来——
 * 所以这里做的是「配合模型」而不是「强行扭转」。
 */

import type { Logger } from './logger.js';
import type { LlmClient } from './llm.js';

/** 画风类别，决定追加哪些风格词。 */
export type ArtStyle = 'anime' | 'realistic' | 'auto';

/** 翻译结果。 */
export interface PromptResult {
  /** 正向 tag */
  positive: string;
  /** 负向 tag */
  negative: string;
  /** 识别出的画风 */
  style: ArtStyle;
}

/**
 * 各画风的追加词。
 *
 * 【2026-10-23 两轮固定种子实测，两个相反的教训】
 *
 * 第一轮：加了 `flat color, cel shading, clean lineart`
 *   → 脸部发紫、衣服纯红无阴影、像未上色的速写。
 *   `flat color` / `cel shading` 在 SDXL 里会把明暗层次压平，属于毒药。
 *
 * 第二轮：把风格词全砍到只剩 `anime coloring`
 *   → 背景失控：远坂凛满屏红底、saber 橘色火海。
 *   因为 `soft lighting` 和 `simple background` 也一起被砍了，
 *   而这两个属于【构图/光影】，跟【平涂】完全是两回事，不该一起删。
 *
 * 结论：
 *   - 去掉平涂类（flat color / cel shading / clean lineart）
 *   - 保留构图类（simple background / upper body）和光影类（soft lighting）
 *   - anime coloring 保留，它是轻量的画风倾向词，不是毒药
 */
const STYLE_SUFFIX: Record<ArtStyle, string> = {
  // 轻量画风 + 构图 + 光影，三者缺一不可
  anime: 'anime coloring, simple background, soft lighting, upper body',
  realistic: 'photorealistic, detailed skin, natural lighting, simple background, upper body',
  auto: 'simple background, soft lighting',
};

/** 各画风的负向词。 */
const STYLE_NEGATIVE: Record<ArtStyle, string> = {
  // 二次元主模型（NoobAI）本来就出动漫风，
  // 这里只排除真正的 3D/照片感，以及会把画面压平的平涂词
  anime: '3d, 3d render, photograph, cgi, flat color, flat shading, washed out, pale',
  realistic: 'anime, cartoon, illustration, flat color, cel shading',
  auto: '',
};

/** 基础负向词（所有模型通用）。 */
const BASE_NEGATIVE =
  'worst quality, low quality, lowres, bad anatomy, bad hands, extra fingers, ' +
  'missing fingers, watermark, text, signature, username, jpeg artifacts';

/**
 * 从用户话里判断想要的画风。
 *
 * 默认 anime —— 这个机器人的人设是二次元鲸鱼娘，群聊场景也以动漫风为主。
 */
export function detectStyle(text: string): ArtStyle {
  if (/(写实|真实|照片|真人|photo|realistic|photoreal)/i.test(text)) return 'realistic';
  if (/(3d|三维|渲染)/i.test(text)) return 'realistic';
  // 明确说二次元/动漫 → anime
  if (/(二次元|动漫|anime|卡通|漫画风|插画)/i.test(text)) return 'anime';
  return 'anime';
}

/**
 * 翻译系统提示词。
 *
 * 【2026-10-23 修正】之前只写「20~40 个 tag」，实测 LLM 经常只给 8 个
 * （`masterpiece, 1girl, solo, tohsaka rin (fate), fate/stay night, anime coloring`），
 * 缺背景/光影/构图，模型就自由发挥出满屏红底、橘色火海。
 *
 * 所以现在明确要求：说出已知角色的外貌特征、必须带构图与光影词、
 * 并在末尾自检数量。给出正反例比只说数字有效。
 */
const TRANSLATE_SYSTEM = `你是 Stable Diffusion 提示词工程师。把用户的中文画图需求转成英文 Danbooru 风格 tag。

输出规则：
- 只输出 tag，用英文逗号分隔，不要解释、不要中文、不要 markdown、不要编号
- 顺序：质量词 → 主体 → 外貌/服装 → 动作/表情 → 构图 → 背景 → 光影
- 质量词固定开头：masterpiece, best quality

内容规则：
- 角色名必须用 Danbooru 规范写法：角色 (作品)，例如 saber (fate)、tohsaka rin (fate)、furina (genshin impact)
- 如果用户提到具体作品，把作品名也作为 tag 加上
- **如果角色是你认识的，必须补上她的标志性外貌与服装**
  （发色、发型、瞳色、代表服装）。这是角色还原的关键，不算瞎编。
- 用户没提到、你也不确定的细节不要编

构图规则（**必须包含，缺了会导致背景失控**）：
- 单人：1girl/1boy + solo
- 画面只有生物或物体：no humans
- 景别至少一个：upper body / full body / cowboy shot / portrait
- 背景至少一个：simple background / white background / blurred background
- 光影至少一个：soft lighting / cinematic lighting / studio lighting

数量：**至少 15 个 tag，20~35 个最佳**。输出前自检一遍数量够不够。

正确示例：
输入：画一张远坂凛的图片
输出：masterpiece, best quality, 1girl, solo, tohsaka rin (fate), fate/stay night, black hair, long hair, twintails, black ribbon, aqua eyes, red shirt, cross necklace, black skirt, looking at viewer, upper body, simple background, white background, soft lighting

错误示例（tag 太少、缺构图光影，会导致背景变成一片纯色）：
输入：画一张远坂凛的图片
输出：masterpiece, best quality, 1girl, solo, tohsaka rin, fate/stay night, anime coloring`;

/** 识别是否属于露骨内容（仅用于提示"这次大概率会被 LLM 拒绝"）。 */
const EXPLICIT_PATTERN =
  /(全裸|裸体|裸露|裸|露胸|露出.*胸|性交|做爱|性爱|强奸|口交|肛交|射精|阴道|阴茎|乳头|nude|naked|nsfw|explicit|sex|genital|nipple)/i;

export function isExplicitRequest(text: string): boolean {
  return EXPLICIT_PATTERN.test(text);
}

/** 从 LLM 输出里清洗出纯 tag 串。 */
export function sanitizeTags(raw: string): string {
  let t = raw.trim();
  t = t.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '');
  t = t.replace(/^(prompt|tags?|提示词)\s*[:：]\s*/i, '');
  const firstLine = t.split(/\r?\n/).find((l) => l.trim().length > 0) ?? t;
  return firstLine
    .replace(/[\u4e00-\u9fa5]/g, ' ')
    // 去掉中文标点和全角符号：LLM 拒绝回复经过去中文后剩下一堆这类字符
    .replace(/[，。、；：""''（）【】《》？！…—～·]/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/,{2,}/g, ',')
    .replace(/^[,\s]+|[,\s]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * 判断 LLM 是否在拒绝，而不是在翻译。
 *
 * 背景：实测算「全裸的远坂凛」时，DeepSeek 回的是
 *   「抱歉，我不能为《Fate》中未成年设定角色远坂凛生成裸露/性化标签……」
 * 旧代码把这句当 tag 用，去中文后只剩标点，最后拼接出空提示词，
 * ComfyUI 拿着空提示词自由发挥，用户看到的就是"没效果"。
 *
 * 所以要显式识别拒绝，并给出可读的错误，而不是静默降级。
 */
export function looksLikeRefusal(raw: string): boolean {
  const t = raw.trim();
  if (t.length === 0) return true;

  // 典型拒绝句式。注意要检测"拒绝 + 给安全替代"的混合情况：
  // 模型有时会先说「抱歉……」，再补一段合规 tag，这种也算没完成任务。
  const head = t.slice(0, 200);
  const REFUSAL = /(抱歉|对不起|我不能|无法|不便|恕不|不能协助|cannot|can't|sorry|unable|拒绝)/i;
  if (REFUSAL.test(head)) return true;

  // 说得很多但几乎没有英文 tag（正常输出是 tag 串，不是句子）
  const tagLike = t.split(',').filter((s) => /^[a-z0-9\s()\-_:.'!&]+$/i.test(s.trim())).length;
  if (t.length > 60 && tagLike < 3) return true;

  // 没有实质字母 → 无法当提示词用（纯标点、纯符号）
  if (!/[a-zA-Z]/.test(t)) return true;

  // 只剩模板词（"安全替代 tag" 这类拒绝回复被去中文后常留下 tag/prompt 这样的单词）
  const words = t.match(/[a-zA-Z]{2,}/g) ?? [];
  const BOILER = /^(tag|tags|prompt|safe|sfw|safe version|alternative)$/i;
  if (words.length > 0 && words.every((w) => BOILER.test(w))) return true;

  return false;
}

/** 清洗后的 tag 是否足够可用（至少 3 个有效 tag）。 */
export function enoughTags(tags: string): boolean {
  const parts = tags
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 1 && /[a-zA-Z]/.test(s));
  return parts.length >= 3;
}

/** 拼装最终提示词：基础 tag + 画风后缀。 */
export function composePrompt(tags: string, style: ArtStyle): string {
  const suffix = STYLE_SUFFIX[style];
  if (!suffix) return tags;
  // 避免重复
  const lower = tags.toLowerCase();
  const extra = suffix
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !lower.includes(s.toLowerCase()));
  return extra.length > 0 ? `${tags}, ${extra.join(', ')}` : tags;
}

/** 拼装负向提示词。 */
export function composeNegative(style: ArtStyle, userNegative?: string): string {
  const parts = [BASE_NEGATIVE];
  if (STYLE_NEGATIVE[style]) parts.push(STYLE_NEGATIVE[style]);
  if (userNegative) parts.push(userNegative);
  return parts.join(', ');
}

/** 翻译选项。 */
export interface TranslateOptions {
  /** 预留字段；当前翻译流程不使用额外选项 */
  _unused?: never;
}

/**
 * 翻译中文需求为提示词。
 *
 * @param raw 用户原话
 * @param llm LLM 客户端（未配置时返回空，调用方降级）
 * @param logger 日志
 */
export async function translateToPrompt(
  raw: string,
  llm: LlmClient,
  logger: Logger,
  options?: TranslateOptions,
): Promise<PromptResult | null> {
  // 去掉触发词与 @ 标记
  const clean = raw
    .replace(/\[艾特你\]/g, '')
    .replace(/@\d+/g, '')
    .replace(/^[\s,，]*/, '')
    .replace(/^(帮我|给我|请|麻烦)?\s*/, '')
    .replace(/^(画|生成|来)(一?[张幅个只条头朵棵座栋间件套]|一下|个)?/, '')
    .replace(/(的图|图片|一张图|吧|呀|啊|哦)$/g, '')
    .trim();

  if (clean.length === 0) return null;

  const style = detectStyle(raw);

  // 已经是英文 tag 就直接用
  const isAscii = /^[\x20-\x7E,()\[\]\-_.:]+$/.test(clean);
  if (isAscii && clean.split(',').length >= 3) {
    logger.info('检测到英文 tag，跳过翻译', { style });
    const base = /masterpiece/i.test(clean) ? clean : `masterpiece, best quality, ${clean}`;
    return { positive: composePrompt(base, style), negative: composeNegative(style), style };
  }

  if (!llm.enabled) {
    logger.info('LLM 不可用，无法翻译提示词');
    return null;
  }

  try {
    // 面板开启了宽松模式时用另一套 system prompt。
    // 注意：这只影响我们自己的过滤策略，模型自身的安全限制仍在。
    const system = TRANSLATE_SYSTEM;
    const res = await llm.complete([
      { role: 'system', content: system },
      { role: 'user', content: clean },
    ]);

    // 先判断是不是拒绝回复。旧代码不判，把「抱歉，我不能……」当成 tag 用，
    // 去中文后剩下一堆标点，最后交给 ComfyUI 一个空提示词 —— 用户看到的"没效果"就是这个。
    if (looksLikeRefusal(res.content)) {
      logger.info('翻译被模型拒绝', {
        from: clean.slice(0, 40),
                reply: res.content.slice(0, 80),
      });
      return null;
    }

    const tags = sanitizeTags(res.content);
    if (!enoughTags(tags)) {
      logger.info('清洗后 tag 不足，判定失败', {
        from: clean.slice(0, 40),
        tags: tags.slice(0, 80),
      });
      return null;
    }

    const positive = composePrompt(tags, style);
    logger.info('提示词翻译完成', {
      from: clean.slice(0, 40),
      style,
      to: positive.slice(0, 160),
    });
    return { positive, negative: composeNegative(style), style };
  } catch (error) {
    logger.info('提示词翻译失败', { message: (error as Error).message.slice(0, 100) });
    return null;
  }
}

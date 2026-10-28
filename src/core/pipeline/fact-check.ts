/**
 * 事实核查：用户发图（或引用含图消息）质疑真假时，
 * 先让视觉模型读图，把图里的关键信息转成文字，再拿这些信息去搜索。
 *
 * 为什么需要（2026-10-28 真实故障）：
 *   用户发了一张「美国国防部长带100亿美元现金坐C-130飞德黑兰」的截图，
 *   问是不是真的。机器人**完全没看图**，只聊了文字，
 *   然后说"正规媒体没报道，八成是编的"。
 *   虽然结论碰巧对，但它其实没有任何依据——图里的信源名、
 *   时间戳、排版破绽全都没被分析。
 *
 * 而且是更根本的问题：机器人用「我没搜到 → 所以是假的」来推断，
 *   这既不能证伪，也忽略了它知识截止这个前提。
 *
 * 设计要点：
 *   1. 只在「有图 + 表达质疑/求证」时才多花一次视觉调用
 *   2. 读图产出结构化摘要（关键人名/机构名/日期/数字/可疑点）
 *   3. 摘要直接拼进搜索词，让搜索有真实抓手
 *   4. 视觉失败不影响主流程
 */

import type { PipelineContext } from './context.js';
import type { Logger } from '../logger.js';

/** 质疑/求证的说法。 */
const VERIFY_PATTERN =
  /(真的假的|是不是真|是不是假|真假|真的吗|属实|可靠|可信|靠谱|八成是编|P的|p的|伪造|假新闻|谣言|求证|辟谣|核实|确认一下|这是真的|有没有这回事|发生过吗|有这回事|有这事|这是真事|真的发生)/;

/**
 * 是否在质疑真假。
 *
 * 注意「辟谣」这个词：字面是"辟"，但整词是"辟谣"，
 * 所以不能用单字「辟」。原来的正则里写的是「辟谣」，
 * 但 `帮我辟个谣` 中间插了「个」，匹配不上。
 * 改成允许中间的插入成分。
 */
export function looksLikeFactCheck(text: string): boolean {
  const t = text.replace(/\[艾特你\]/g, '').trim();
  if (t.length < 3) return false;
  if (VERIFY_PATTERN.test(t)) return true;
  // 「辟个谣」「求个证」这类插入式说法
  if (/辟.{0,2}谣|求.{0,2}证|核.{0,2}实/.test(t)) return true;
  return false;
}

export interface ImageFacts {
  /** 图里的关键信息（人名/机构/日期/数字），用于搜索 */
  searchTerms: string;
  /** 给模型看的完整读图摘要 */
  summary: string;
  /** 发现的疑点 */
  redFlags: string[];
}

/**
 * 读图并抽取可用于搜索的事实。
 *
 * @param imageDataUrls collectImages 得到的 data URL
 * @returns 抽取结果；没有图或失败返回 null
 */
export async function extractImageFacts(
  ctx: PipelineContext,
  imageDataUrls: string[],
  userText: string,
  logger: Logger,
): Promise<ImageFacts | null> {
  const { llm, config } = ctx;
  if (!config.vision.enabled || !llm.enabled) return null;
  if (imageDataUrls.length === 0) return null;

  try {
    const res = await llm.complete([
      {
        role: 'system',
        content:
          '你是图片事实核查助手。仔细看用户发来的图片，输出三部分：\n' +
          '【图中信息】把图里所有能读到的事实写出来：标题、正文要点、' +
          '人名、机构名、职位、日期、金额、地点、消息来源署名、平台水印。' +
          '不要评价，只客观描述看到什么。看不清就说看不清。\n' +
          '【可疑点】列出排版/内容上的破绽：日期是否合理、' +
          '信源是否可辨认、措辞是否符合正规媒体习惯、图片是否有拼接痕迹。\n' +
          '【搜索词】输出 1~2 组用于核实的关键词，用空格分隔，' +
          '要包含最具体的人名/机构/事件，不要用"这图""该消息"这类泛称。\n\n' +
          '严格按上面三段输出，每段用一个换行分隔。',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: `用户的说法：${userText.slice(0, 200)}` },
          ...imageDataUrls.slice(0, 3).map((url) => ({
            type: 'image_url' as const,
            image_url: { url },
          })),
        ],
      },
    ]);

    const raw = res.content.trim();
    if (raw.length === 0) return null;

    const infoBlock = section(raw, '图中信息');
    const flagBlock = section(raw, '可疑点');
    const termBlock = section(raw, '搜索词');

    // 搜索词取不到就退回"图中信息"的前 60 字
    const searchTerms = (termBlock || infoBlock).replace(/\s+/g, ' ').trim().slice(0, 80);
    if (searchTerms.length < 2) return null;

    const redFlags = flagBlock
      .split(/[。；;\n]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 2)
      .slice(0, 4);

    logger.info('图片事实已抽取', {
      搜索词: searchTerms.slice(0, 60),
      疑点: redFlags.length,
    });

    return {
      searchTerms,
      summary: infoBlock.slice(0, 800) || raw.slice(0, 800),
      redFlags,
    };
  } catch (error) {
    logger.info('读图失败，退回纯文字', {
      message: (error as Error).message.slice(0, 120),
    });
    return null;
  }
}

/** 从分段文本里取某一段。 */
function section(text: string, name: string): string {
  // 匹配 【名字】 到下一个 【 或结尾
  const re = new RegExp(`【${name}】([\\s\\S]*?)(?=【|$)`);
  const m = re.exec(text);
  return m?.[1]?.trim() ?? '';
}

/** 把读图结果渲染成注入提示词的文本块。 */
export function renderImageFacts(facts: ImageFacts): string {
  const parts: string[] = ['【图片核查结果】', facts.summary];
  if (facts.redFlags.length > 0) {
    parts.push('', '【可疑点】');
    for (const f of facts.redFlags) parts.push(`- ${f}`);
  }
  return parts.join('\n');
}

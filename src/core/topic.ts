/**
 * 话题类型检测：决定回复字数上限。
 *
 * 为什么要分场景：
 *   群里闲聊就一两句话最自然，说多了像机器人；
 *   但遇到技术问题（报错、原理、怎么写），短回复根本讲不清。
 *   所以字数上限不该是一个固定值，而应该随话题类型浮动。
 *
 * 判定方式：关键词匹配。不做 LLM 调用（那会多一次开销），
 * 关键词表覆盖常见的编程/AI/排障表达，宁宽勿严。
 */

/** 技术类关键词。 */
const TECH_KEYWORDS: RegExp[] = [
  // 编程语言与工具
  /\b(typescript|javascript|python|java|golang|\bgo\b|rust|c\+\+|c#|php|ruby|swift|kotlin|sql)\b/i,
  /\b(react|vue|angular|svelte|next\.?js|nuxt|node|deno|bun|npm|pnpm|yarn|vite|webpack)\b/i,
  /\b(docker|kubernetes|k8s|nginx|redis|mysql|postgres|sqlite|mongo|kafka|rabbitmq)\b/i,
  /\b(git|github|gitlab|ci\/cd|jenkins|pipeline|deploy|部署)\b/i,
  // AI 与大模型
  /\b(llm|gpt|claude|deepseek|prompt|rag|embedding|token|api|sdk|agent|模型|大模型|提示词)\b/i,
  // 常见技术动作
  /报错|崩溃|异常|error|exception|traceback|stack ?trace|bug|调试|debug|日志|log\b/i,
  /原理|实现|架构|算法|复杂度|性能|优化|重构|源码|代码|函数|变量|接口|数据库|索引|缓存|并发|线程|异步/i,
  // 学习/请教类
  /怎么写|怎么实现|如何实现|为什么|区别是|有什么区别|帮我看看|解释一下|讲一下|科普/i,
];

/** 判断一句话是否属于技术/学习类话题。 */
export function isTechnicalTopic(text: string): boolean {
  if (text.trim().length === 0) return false;
  return TECH_KEYWORDS.some((re) => re.test(text));
}

/**
 * 计算本次回复的字数上限。
 *
 * @param baseChars 人设配置的平时上限
 * @param techChars 技术话题上限；缺省时取 max(baseChars, 300)，
 *                  保证技术问题至少能说 300 字，但不会低于调高的基础值
 * @param texts 用于判断话题的文本（当前消息 + 可选上下文）
 */
export function resolveReplyLimit(
  baseChars: number | undefined,
  techChars: number | undefined,
  texts: string[],
): number {
  const base = baseChars ?? 120;
  // 技术上限不得低于基础上限，否则调大 base 反而在技术场景被截得更短
  const tech = techChars ?? Math.max(base, 300);
  const joined = texts.join(' ');
  return isTechnicalTopic(joined) ? Math.max(tech, base) : base;
}

/**
 * 是否属于「需要交代内容」的任务：视频总结、长文摘要、多个要点归纳。
 *
 * 为什么要单独放开：这类回复天生需要铺开讲，120 字根本说不完，
 * 强行截断会让句子断在半截（实测视频总结被切在 120 字，句子明显没说完）。
 * 这与闲聊不同——闲聊本来就该短。
 */
const RECAP_PATTERN =
  /(视频|音频|这篇文章|文章|链接|帖子|内容).{0,6}(说|讲|聊|写)(了|什么|啥|的|一下)|(总结|概括|摘要|归纳|梳理|要点|讲了啥|说了啥|说了什么|讲了什么)/;

export function needsRecap(text: string): boolean {
  return RECAP_PATTERN.test(text);
}

/**
 * 是否要求「详细」输出。
 *
 * 实测背景：用户说「详细说说这视频讲了什么」时，
 * 旧逻辑只按 recap 档（600 字）输出，包含不了"总结 + 细节 + 分析"三段结构，
 * 结果要么被截断，要么只讲了其中一部分。
 *
 * 详细模式的要求：
 *   - 分段结构（总结 / 细节 / 分析）
 *   - 字数上限提到 1500
 *   - 允许模型分多段说完，不强行压成一段
 */
const DETAIL_PATTERN =
  /(详细|详尽|具体|展开|细说|完整|全面|深入|逐条|每一个细节|尽量多|多讲|多写|不要省略|别省略|说全)/;

export function wantsDetail(text: string): boolean {
  return DETAIL_PATTERN.test(text);
}

/**
 * 是否是翻译请求。
 *
 * 【2026-10-29 真实故障】用户说「翻译一下这段话」，
 * 旧逻辑匹配不到 recap / detail，落到 chat 档（120 字），
 * 翻译长文时被硬截断，只翻了一半。
 *
 * 翻译的本质是**信息搬运**，必须完整——截断就等于没翻完。
 * 所以单独给一档，而且优先级高于 recap（翻译比总结更需要完整）。
 */
const TRANSLATE_PATTERN =
  /(翻译|翻成|译为|译成|翻一下|翻译成|translate|中译英|英译中|日译中|中译日)/i;

export function wantsTranslation(text: string): boolean {
  return TRANSLATE_PATTERN.test(text);
}

/**
 * 计算回复的字数上限。
 *
 * 五个档位（按优先级）：
 *   detail      1500+  明确要求"详细/完整/展开"
 *   translate   2000   翻译请求（必须完整，不能截断）
 *   recap        600   内容交代（总结/说了什么）
 *   tech         300   技术问题
 *   chat         120   闲聊
 *
 * 翻译档为什么排在 recap 前面：
 *   翻译是信息搬运，截断就等于没翻完。
 *   而 recap（总结）本身就允许压缩。
 *
 * @param recapChars 内容交代场景的上限（如视频总结）
 * @param detailChars 详细模式的上限；缺省取 recap 的 2.5 倍
 */
export function resolveReplyLimitWithRecap(
  baseChars: number | undefined,
  techChars: number | undefined,
  recapChars: number | undefined,
  texts: string[],
  detailChars?: number,
): { limit: number; kind: 'detail' | 'translate' | 'recap' | 'tech' | 'chat' } {
  const base = baseChars ?? 120;
  const tech = techChars ?? Math.max(base, 300);
  const recap = recapChars ?? Math.max(tech, 600);
  const detail = detailChars ?? Math.max(recap * 2.5, 1500);

  const joined = texts.join(' ');

  // 翻译优先于一切：它必须完整
  // （用户说"详细翻译"时也走这里，因为 detail 已经含在 translate 的上限里了）
  if (wantsTranslation(joined)) {
    return { limit: Math.max(detail * 1.5, 2000), kind: 'translate' };
  }

  // 详细优先：它比普通 recap 需要更多空间承载分段结构
  if (wantsDetail(joined)) {
    return { limit: Math.max(detail, recap, tech, base), kind: 'detail' };
  }
  // 内容交代优先：它需要的信息量比技术问题还大
  if (needsRecap(joined)) return { limit: Math.max(recap, tech, base), kind: 'recap' };
  if (isTechnicalTopic(joined)) return { limit: Math.max(tech, base), kind: 'tech' };
  return { limit: base, kind: 'chat' };
}

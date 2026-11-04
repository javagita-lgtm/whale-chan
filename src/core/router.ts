/**
 * 语义路由（function calling 优先，正则兜底）。
 *
 * ## 定位
 *
 * 这个模块只负责「判断用户想干什么 + 提取参数」，
 * 不负责执行（执行还在各 pipeline 里）。
 *
 * ## 为什么两层
 *
 * - **tool 层**：模型语义判断，能cover「放《This game》」这类正则写不出的说法
 * - **正则层**：模型有概率该调不调（temperature、上下文干扰、模型退化），
 *   所以不能全指望它。正则作为兜底，保证「至少不会比以前差」。
 *
 * 两层的优先级：**tool 命中就用 tool，没命中再跑正则**。
 *
 * ## 成本
 *
 * tool 调用和正常对话是**同一次 API 请求**，不额外增加延迟或费用。
 * 但路由本身需要一次请求——如果路由和对话合并，才是真正零额外成本。
 * 当前实现是独立一次请求（minTokens、低温度），方便渐进迁移；
 * 后续可以把「路由 + 对话」合并成一次。
 */

import type { Logger } from './logger.js';
import type { LlmClient, ToolCall } from './llm.js';
import { ALL_TOOLS } from './tools.js';
import { wantsImage } from './image-gen.js';
import { wantsOriginal, wantsSing } from './singer.js';
import { looksLikeSearchIntent } from './web.js';
import { wantsSpeech } from './tts.js';

/** 路由结果：用户想干什么。 */
export type Intent =
  | { kind: 'play_song'; title: string; artist?: string; mode: 'original' | 'sing'; via: 'tool' | 'regex' }
  | { kind: 'generate_image'; prompt: string; reference?: string; via: 'tool' | 'regex' }
  | { kind: 'web_search'; query: string; freshness?: string; via: 'tool' | 'regex' }
  | { kind: 'speak'; text?: string; emotion?: string; via: 'tool' | 'regex' }
  | { kind: 'chat'; via: 'none' };

export interface RouteOptions {
  logger: Logger;
  llm: LlmClient;
  /** 关掉 tool 只跑正则（排查用） */
  disableTools?: boolean;
}

/**
 * 用 function calling 判断意图。
 *
 * 返回 `{ intent, reachable }`：
 *   - `reachable=true` + `intent=null` → 模型成功响应但认为不该执行动作（普通聊天）
 *   - `reachable=false` → 调用失败，需要正则兜底
 */
async function routeWithTools(
  llm: LlmClient,
  logger: Logger,
  text: string,
): Promise<{ intent: Intent | null; reachable: boolean }> {
  try {
    const r = await llm.complete(
      [
        {
          role: 'system',
          content:
            '你是一个意图路由器。根据用户这句话，判断他想要机器人做什么，'
            + '需要时调用对应的工具。'
            + '如果只是普通聊天、提问、或者没有明确要执行的动作，就**不要调用任何工具**，'
            + '直接回复一个空字符串。',
        },
        { role: 'user', content: text },
      ],
      {
        tools: ALL_TOOLS,
        toolChoice: 'auto',
        // 路由只要判断，不需要创造力
        temperature: 0,
        // 工具调用响应很短，但推理模型会先消耗思维链，给足预算
        maxTokens: 512,
      },
    );

    const calls = r.toolCalls ?? [];
    if (calls.length === 0) {
      return { intent: null, reachable: true };
    }

    return { intent: intentFromToolCall(calls[0]!, logger), reachable: true };
  } catch (error) {
    logger.info('语义路由失败，回退正则', {
      message: (error as Error).message.slice(0, 120),
    });
    return { intent: null, reachable: false };
  }
}

/** 把一次 tool_call 转成 Intent。参数不合法时返回 null。 */
export function intentFromToolCall(call: ToolCall, logger: Logger): Intent | null {
  const a = call.args;

  switch (call.name) {
    case 'play_song': {
      const title = String(a['title'] ?? '').trim();
      if (!title) {
        logger.info('play_song 缺少 title，忽略', { raw: call.rawArgs.slice(0, 80) });
        return null;
      }
      const mode = a['mode'] === 'sing' ? 'sing' : 'original';
      const artist = String(a['artist'] ?? '').trim();
      return { kind: 'play_song', title, mode, ...(artist ? { artist } : {}), via: 'tool' };
    }

    case 'generate_image': {
      const prompt = String(a['prompt'] ?? '').trim();
      if (!prompt) return null;
      const reference = String(a['reference'] ?? '').trim();
      return { kind: 'generate_image', prompt, ...(reference ? { reference } : {}), via: 'tool' };
    }

    case 'web_search': {
      const query = String(a['query'] ?? '').trim();
      if (!query) return null;
      const freshness = String(a['freshness'] ?? '').trim();
      return {
        kind: 'web_search',
        query,
        ...(freshness && freshness !== 'any' ? { freshness } : {}),
        via: 'tool',
      };
    }

    case 'speak': {
      const text = String(a['text'] ?? '').trim();
      const emotion = String(a['emotion'] ?? '').trim();
      return {
        kind: 'speak',
        ...(text ? { text } : {}),
        ...(emotion ? { emotion } : {}),
        via: 'tool',
      };
    }

    default:
      logger.info('未知工具，忽略', { name: call.name });
      return null;
  }
}

/**
 * 正则兜底（保留原有 16 个判断函数里的高频几个）。
 *
 * 只兜最关键的，不求全覆盖——没命中的就当普通聊天，和以前行为一致。
 */
/**
 * 纯正则路由（不调 LLM）。
 *
 * 用途：作为 `route()` 的兜底层，也被 pipeline 用作
 * 「模型没请求工具时再试一次」的保险。
 */
export function routeWithRegexOnly(text: string): Intent {
  return routeWithRegex(text);
}

function routeWithRegex(text: string): Intent {
  // 顺序重要：唱/放歌优先（它最容易被误判成聊天）
  const sing = wantsSing(text);
  const orig = wantsOriginal(text);
  if (sing || orig) {
    // 从原句里粗暴扒歌名：书名号 > 引号 > 「唱/放」后面的部分
    const title = extractTitle(text);
    if (title) {
      return {
        kind: 'play_song',
        title,
        mode: sing ? 'sing' : 'original',
        via: 'regex',
      };
    }
  }

  if (wantsImage(text)) {
    return { kind: 'generate_image', prompt: text, via: 'regex' };
  }

  if (looksLikeSearchIntent(text)) {
    return { kind: 'web_search', query: text, via: 'regex' };
  }

  if (wantsSpeech(text)) {
    return { kind: 'speak', via: 'regex' };
  }

  return { kind: 'chat', via: 'none' };
}

/** 从「放《X》」这类话里扒歌名。 */
export function extractTitle(text: string): string {
  const t = text.replace(/\[艾特你\]/g, '').trim();

  // 书名号 / 各种引号
  const quoted = /[《「『“"‘']([^》」』”"’']{1,40})[》」』”"’']/.exec(t);
  if (quoted?.[1]) return quoted[1].trim();

  // 「唱/放/听」后面的内容，去掉量词和尾巴
  const after = /(?:唱|放|听|点歌|播放)\s*(?:一?首|个|下|一下)?\s*([^\s，。！？,.!?]{1,40})/.exec(t);
  if (after?.[1]) {
    return after[1]
      .replace(/(这首歌|的歌|听听|一下|吧|呢|啊|呀)+$/u, '')
      .trim();
  }

  return '';
}

/** 否定说法（「我不想听歌」「别放了」）。 */
const NEGATIVE_PATTERN = /(不想|不要|别|不用|不必|讨厌).{0,4}(唱|听|放)/;

/**
 * 极其保守的「这句一定是在要歌」判定。
 *
 * 用途：只在**模型没请求工具**时作为最后保险，避免功能整体失效。
 *
 * 为什么不用 `wantsMusic`：那套正则覆盖广，但会把
 * 「这个视频详细说了什么」这类句子里的历史歌名也当成放歌。
 * 实测由此触发了一次完全无关的唱歌。
 *
 * 这里只认**当前句子里同时出现**「播放类动词」+「明确指向」的组合：
 *   ✅ 放《X》   ✅ 播放 X   ✅ 想听 X   ✅ 唱一首 X   ✅ 点歌 X
 *   ❌ 这个视频说了什么（没有播放动词）
 *   ❌ X 是谁唱的（没有播放动词）
 */
export function isUnmistakableMusicRequest(text: string): boolean {
  const t = text.replace(/\[艾特你\]/g, '').trim();
  if (t.length < 3) return false;

  // 否定句直接排除
  if (NEGATIVE_PATTERN.test(t)) return false;

  // 排除「放 + 非歌」的常见词
  if (/^放\s*(假|学|晴|松|心|大|屁|开|置|弃|任|宽|手|低|血|电|射|慢|快|眼|声)/.test(t)) {
    return false;
  }

  // 「唱」用于讨论/评价时不是要歌。
  // 实测误判：「这首歌唱的是谁」「我觉得你唱得不错」「你刚才唱了什么」
  // 共同点：「唱」后面接的是「得/的/了」或疑问词，是在说唱这件事本身。
  if (/唱\s*(得|的|了|过|完|罢)/.test(t)) return false;
  if (/唱\s*(什么|啥|谁|哪|怎么|如何)/.test(t)) return false;

  // 明确的播放动词 + 后面跟着内容
  // 「放《X》」「放一首 X」「放 X」「播放 X」
  if (/放\s*[《「『“"'\[]/.test(t)) return true;
  if (/放\s*(一?首)\s*\S/.test(t)) return true;
  if (/播放\s*\S/.test(t)) return true;
  if (/(想听|要听)\s*\S/.test(t)) return true;

  // 「唱/点歌」+ 书名号 或 量词 + 内容
  if (/(唱|点歌)\s*[《「『“"'\[]/.test(t)) return true;
  if (/(唱|点歌)\s*一?首\s*\S/.test(t)) return true;
  // 「点歌 X」：点歌后面直接跟内容
  if (/^点歌\s*[^\s，。！？,.!?]{2,}/.test(t)) return true;
  // 「唱 X」：唱后面直接跟 2 字以上的实体（但不能是上面已排除的讨论用法）
  if (/^唱\s*[^\s，。！？,.!?]{2,}/.test(t)) return true;

  // 「放首歌」这类没歌名的泛请求
  if (/^放\s*(首|个)?歌/.test(t)) return true;

  return false;
}

/**
 * 主入口：判断意图。
 *
 * tool 优先，失败/未命中则正则兜底。
 *
 * ## 一个重要细节：tool "明确说不" 时不该被正则推翻
 *
 * 实测：`画画真有意思` 模型正确判为 chat（不调工具），
 * 但正则兜底把 `画`+`画` 当成生图，反而劫持了模型的正确判断。
 *
 * 所以这里区分两种「tool 没返回」：
 *   - **调用失败**（网络/超时/模型不支持）→ 走正则兜底（正确）
 *   - **成功但没调工具** → 模型认为不该执行动作，**尊重它，直接 chat**
 *
 * 后一种情况下如果也跑正则，等于「模型说不、正则说行」，
 * 那语义路由就白做了。正则只在 tool 层彻底挂掉时兜底。
 */
export async function route(opts: RouteOptions, text: string): Promise<Intent> {
  const { logger, llm, disableTools } = opts;

  if (!disableTools && llm.enabled) {
    const { intent: byTool, reachable } = await routeWithTools(llm, logger, text);
    if (byTool) {
      logger.info('语义路由命中', {
        kind: byTool.kind,
        via: byTool.via,
        args: JSON.stringify(byTool).slice(0, 120),
      });
      return byTool;
    }

    // tool 层成功返回但没有工具调用 —— 模型认为这是普通聊天。
    // 信任这个判断，不再让正则推翻它。
    if (reachable) {
      return { kind: 'chat', via: 'none' };
    }
  }

  const byRegex = routeWithRegex(text);
  if (byRegex.kind !== 'chat') {
    logger.info('正则兜底命中', {
      kind: byRegex.kind,
      title: byRegex.kind === 'play_song' ? byRegex.title : undefined,
    });
  }
  return byRegex;
}

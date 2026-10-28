/**
 * 提示词拼装：人设 → 群规 → 上下文 → 当前消息。
 *
 * 这里刻意把「上下文渲染」与「模型调用」分开，
 * 便于单测覆盖（给死数据断言拼出来的字符串）以及后续换模型不改业务。
 */

import type { ChatMessage, ContentPart } from './llm.js';
import type { Persona } from './persona.js';
import type { StoredMessage } from './memory.js';
import type { MessageEvent } from './types.js';

export interface PromptBuildOptions {
  persona: Persona;
  event: MessageEvent;
  /** 历史消息（不含当前这条，按时间升序） */
  history: StoredMessage[];
  /** 上下文字符上限 */
  maxContextChars: number;
  /** 机器人在群里的昵称 */
  botName: string;
  /** 供模型挑选的表情包候选（真实图库标题）；为空则不提示发表情 */
  stickerCandidates?: Array<{ id: string; title: string }>;
  /** 已转成 data URL 的图片，作为多模态内容送进模型 */
  imageDataUrls?: string[];
  /** 是否为主动插话（无人 @），影响结尾指令的措辞 */
  proactive?: boolean;
  /** 已抓取的网页内容块（用户发了链接时） */
  pageBlocks?: string[];
  /** 联网搜索结果块 */
  searchBlock?: string;
}

const SPEAKER_UNKNOWN = '群友';

function formatClock(tsSeconds: number): string {
  const d = new Date(tsSeconds * 1000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * 完整日期时间，用于告诉模型「今天是几号」。
 *
 * 【2026-10-28 真实故障】用户发了一张标着「2026年10月27日」的截图，
 * 机器人说「这日期是未来的，现在就被截图传出来了，时光机有点先进啊」——
 * 实际上那天就是 10月28日，截图是昨天的，完全正常。
 *
 * 根因：prompt 里只有 `（现在是 10:32）`，没有日期。
 * 模型不知道今天是几号，只能靠训练数据的截止时间猜，于是把正常日期当成未来。
 */
function formatDate(tsSeconds: number): string {
  const d = new Date(tsSeconds * 1000);
  const y = d.getFullYear();
  const mo = d.getMonth() + 1;
  const day = d.getDate();
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  return `${y}年${mo}月${day}日 星期${week}`;
}

/** 渲染历史为「昵称: 内容」的多行文本。 */
export function renderHistory(history: StoredMessage[], botName: string): string[] {
  return history.map((m) => {
    const who = m.fromSelf ? botName : m.nickname || SPEAKER_UNKNOWN;
    const body = m.text.length > 0 ? m.text : '（非文字内容）';
    return `${who}: ${body}`;
  });
}

/** 从尾部往前裁剪，保证总字符数不超过上限。 */
export function trimToCharBudget(lines: string[], maxChars: number): string[] {
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string;
    if (used + line.length > maxChars && kept.length > 0) break;
    kept.unshift(line);
    used += line.length;
  }
  return kept;
}

/** 组装发送给模型的 messages 数组。 */
export function buildMessages(options: PromptBuildOptions): ChatMessage[] {
  const {
    persona, event, history, maxContextChars, botName,
    stickerCandidates, imageDataUrls, proactive, pageBlocks, searchBlock,
  } = options;

  const sceneDesc =
    event.scene === 'group'
      ? `你现在身处一个 QQ 群（群号 ${event.peerId}${event.peerName ? `，群名「${event.peerName}」` : ''}）的聊天中。`
      : `你正在和 QQ 用户「${event.sender.nickname || event.sender.userId}」私聊。`;

  const rules = [
    `你叫「${persona.name}」，是这个群里的普通成员，不是客服也不是助手。`,
    sceneDesc,
    // 日期锚点：不写这条，模型会拿训练截止时间当"现在"，
    // 把正常的近期日期当成"未来"，进而质疑整条消息是假的。
    `今天是 ${formatDate(event.timestamp)}，现在 ${formatClock(event.timestamp)}。` +
      `你的训练数据有截止时间，近期的新闻、人事变动、赛况、股价你天然不知道，` +
      `所以涉及具体事实时必须依赖下面的联网搜索结果，不能靠自己"记得"。`,
    // 能力声明：persona 里写了"不要假装联网搜索"，
    // 模型于是老实说"我没法去联网翻新闻"。要明确告诉它这轮到底有没有搜。
    '如果下面的上下文里出现了【联网搜索结果】或【图片核查结果】，说明这一轮已经真的查过了，' +
      '直接引用里面的信息回答，不要说"我没法联网""我查不到"。' +
      '如果确实没有出现这些块，而对方问的又是近期事实，就坦白说"我这边没搜到相关内容"，' +
      '不要用"这八成是假的"来代替"我没查到"。',
    // 身份边界：不写清这条，模型会把自己发的东西当成别人发的。
    // 真群实测：机器人发了张图，用户问「你从哪找的图」，
    // 它回「这图明明是你自己甩过来的」「贼喊捉贼」——逻辑彻底崩坏。
    `聊天记录里以「${persona.name}:」开头的是【你自己】说过的话、发过的图或表情包；` +
      `其他名字开头的才是群友。` +
      `如果有人问你某张图/某个表情包的来源，而那东西在记录里是你发的，就直接承认是你发的，` +
      `千万不要反问对方"这不是你发的吗"，也不要指控对方贼喊捉贼。`,
    persona.replyMaxChars
      ? `闲聊时一句话就够，尽量不超过 ${persona.replyMaxChars} 个字；` +
        `但对方问的是技术、原理或具体做法时，可以放宽到 ${persona.replyTechMaxChars ?? 300} 个字把话说清楚；` +
        `如果对方要你总结视频/文章/链接里讲的内容，要放宽到 ${persona.replyRecapMaxChars ?? 600} 个字，` +
        `把关键信息交代完整，不要把话说一半就停；` +
        `如果对方明确说「详细」「完整」「展开说」「具体讲讲」，可以用到 ${persona.replyDetailMaxChars ?? 1500} 个字，` +
        `并且要分三段写完：先一句话总结整体讲了什么，再挑几个关键细节展开，最后给出你的看法。` +
        `这种情况宁长勿短，绝对不要漏内容或中途停住。`
      : '',
    '群里有多人在说话，你只针对被点名的那句或最近的话题回应，不要复述别人说过的话。',
    '不要使用 Markdown 语法、不要分点列清单，像真人打字一样。',
    '但要你详细总结内容时，可以分几段写（段落之间正常分段即可），不要挤成一大坨。',
    '不要提到自己是 AI、模型或程序；不要编造你不知道的事实，不确定就用口语说不确定。',
    '遇到政治、色情、违法犯罪、人身攻击等敏感话题时，简短拒绝并转移话题。',
  ]
    .filter((line) => line.length > 0)
    .join('\n');

  const systemPrompt = `${persona.systemPrompt}\n\n【行为规则】\n${rules}`;

  const historyLines = renderHistory(history, botName);
  const kept = trimToCharBudget(historyLines, maxContextChars);

  const contextBlock =
    kept.length > 0
      ? `【最近群聊记录】\n${kept.join('\n')}\n【记录结束】`
      : '【最近群聊记录】（暂无）';

  const speaker = event.sender.nickname || event.sender.userId;
  const nowLine = `（现在是 ${formatClock(event.timestamp)}）`;
  // @ 自身的标记只用于触发判定，不应作为消息正文喂给模型，否则会被当成正文的一部分模仿。
  const bodyText = event.text.replace(/\[艾特你\]/g, '').trim() || '（非文字内容）';
  const currentLine = event.scene === 'group' ? `${speaker}: ${bodyText}` : bodyText;

  // 主动插话与被动回应的措辞差异：没人 @ 你时，要显得是「掺和一句」而不是「回答提问」
  const instruction = proactive
    ? `没有人 @ 你，是你自己想插一句。请以「${persona.name}」的身份自然地掺和进这个话题，` +
      '像群里随口接一句那样，不要显得刻意，也不要总结大家说了什么。只输出这句话本身。'
    : `请以「${persona.name}」的身份直接回复这条消息。只输出回复内容本身，不要带任何前缀或引号。`;

  const userPrompt = [
    contextBlock,
    nowLine,
    // 网页内容放前面：模型先读资料，再看问题，回答更贴合
    ...(pageBlocks ?? []),
    searchBlock ?? '',
    `【需要你回应的消息】\n${currentLine}`,
    instruction,
    buildStickerHint(stickerCandidates ?? []),
  ].filter((s) => s.trim().length > 0).join('\n\n');

  // 有可识别的图片时，user 消息改为多模态内容块：文字提示 + 图片
  const images = imageDataUrls ?? [];
  const userContent: string | ContentPart[] =
    images.length === 0
      ? userPrompt
      : [
          { type: 'text', text: userPrompt },
          {
            type: 'text',
            text: '（下面是对方发来的图片，你可以直接看到内容）',
          },
          ...images.map((url): ContentPart => ({ type: 'image_url', image_url: { url } })),
        ];

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];
}

/**
 * 表情包决策提示。
 *
 * 设计取舍：不让模型自由描述情绪（那样描述的词往往与图库标题对不上，
 * 导致检索命中率为 0），而是给出**真实存在的图库标题候选**让它挑，
 * 或者允许它从候选里「借词」来构造一个能命中的说法。
 *
 * 输出用 HTML 注释包裹：不污染正文，清洗时一次性剥离。
 */
function buildStickerHint(candidates: Array<{ id: string; title: string }>): string {
  if (candidates.length === 0) return '';
  const list = candidates.map((c) => `- ${c.id}：${c.title}`).join('\n');
  return [
    '\n\n另外：如果此刻配一张表情包会更自然，就在回复的最后另起一行输出',
    '<!--sticker: 编号-->（例如 <!--sticker: 029-->）。',
    '下面是图库里真实存在的候选图，**只能从这些编号里挑一个**；不想发就完全不要写这行：\n',
    list,
  ].join('');
}
/** 从模型输出中抽取出表情包情绪提示，并把该注释从正文剥离。 */
export function extractStickerHint(raw: string): { text: string; hint: string | null } {
  const re = /<!--\s*sticker\s*[:：]\s*([\s\S]*?)-->/i;
  const m = re.exec(raw);
  if (!m) return { text: raw, hint: null };
  const hint = (m[1] ?? '').trim();
  const text = raw.replace(re, '').trim();
  return { text, hint: hint.length > 0 ? hint : null };
}

/**
 * 清洗模型输出：去掉常见的前缀、引号、Markdown 残留。
 *
 * 顺序很重要：先剥 Markdown 与引号包裹，再截断。
 * 若先截断，尾部引号可能被截掉一半而无法配对，包裹引号就剥不掉了。
 */
export function sanitizeReply(raw: string, maxChars: number): string {
  let text = raw.trim();

  // 1. 去掉「回复：」「Bot:」这类前缀
  text = text.replace(/(?:^|\n)\s*(?:回复|回答|bot|assistant)\s*[:：]\s*/gi, '').trim();

  // 2. 去掉 Markdown 强调与行内代码
  text = text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').replace(/`(.+?)`/g, '$1');

  // 3. 循环剥离整体包裹的引号（中文引号对，以及成对的 ASCII 双引号），直到不再变化
  for (let i = 0; i < 5; i++) {
    let inner: string | null = null;

    const cn = /^([“「『‘])([\s\S]*)([”」』’])$/u.exec(text);
    if (cn && TEXT_IS_QUOTED(cn[2] as string, cn[1] as string, cn[3] as string)) {
      inner = cn[2] as string;
    }

    if (inner === null) {
      // ASCII 双引号：首尾都是 " 才算包裹（避免把 5"屏 这种误判）
      const ascii = /^"([\s\S]*)"$/.exec(text);
      if (ascii) inner = ascii[1] as string;
    }

    if (inner === null) break;
    const trimmed = inner.trim();
    if (trimmed.length === 0) break;
    text = trimmed;
  }

  // 4. 去掉句末成对的引号装饰，例如：是挺热的，"你也觉得吧"
  text = text.replace(/([，,。！？\s])(["“])([^"“”]*)(["”])\s*$/u, '$1$3').trim();

  // 5. 最后才截断，避免把配对符号切坏
  if (text.length > maxChars) {
    text = text.slice(0, maxChars).replace(/[，,。.、；;：:\s"'“”]+$/u, '');
  }
  return text.trim();
}

/** 判断内部文本是否自成一段（里面不再有同类引号，避免把「他说"你好"」整段误剥）。 */
function TEXT_IS_QUOTED(inner: string, open: string, close: string): boolean {
  return !inner.includes(open) && !inner.includes(close);
}

/**
 * 「这个话题我要不要接一句」的判断提示词。
 *
 * 设计要点：这是一次**轻量**调用——只给最近十几条消息，
 * 让模型回答一个极简的 Yes/No + 可选开场，不生成完整回复。
 * 这样单次 token 消耗远小于一次正常对话。
 */

import type { ChatMessage } from './llm.js';
import type { MessageEvent } from './types.js';

/** 一次插话判断的输出。 */
export interface InterjectVerdict {
  /** 是否要开口 */
  speak: boolean;
  /** 开口时想说的第一句（可为空，后续生成时再补充） */
  opener?: string;
}

/**
 * 组装判断用的 messages。
 *
 * 为什么要求输出 JSON：避免模型说一堆分析把 token 用光，
 * 且便于程序稳定解析。
 */
export function buildInterjectMessages(
  events: MessageEvent[],
  botName: string,
  personaName: string,
): ChatMessage[] {
  const lines = events.map((e) => {
    const who = e.sender.nickname || e.sender.userId;
    const body = e.text.replace(/\[艾特你\]/g, '').trim() || '（非文字内容）';
    return `${who}: ${body}`;
  });

  const system = [
    `你是群聊里的成员「${personaName}」，现在没人 @ 你。`,
    '你的任务是判断：**这轮聊天里，你要不要主动接一句话？**',
    '',
    '只在下面情况才接：',
    '- 有人在聊你了解且能自然接上的话题',
    '- 话题出现明显的空档或尴尬，接一句能救场',
    '- 有梗可以顺',
    '',
    '下面情况不要接：',
    '- 别人在私聊性质地对话，你插进去很突兀',
    '- 话题完全接不上',
    '- 消息只是零碎的状态播报（比如「我到了」「嗯」）',
    '- 本来已经聊得很热，不需要你',
    '',
    '【输出格式】只输出一行 JSON，不要解释、不要 markdown、不要前后缀：',
    '{"speak": true, "opener": "你想说的第一句（不超过20字）"}',
    '或',
    '{"speak": false}',
  ].join('\n');

  const user = [
    `【最近的群聊】`,
    lines.join('\n'),
    '',
    `要不要接一句？只输出 JSON。`,
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** 从模型输出中解析判断结果；解析失败一律视为「不接」。 */
export function parseInterjectVerdict(raw: string): InterjectVerdict {
  const text = raw.trim();
  if (text.length === 0) return { speak: false };

  // 1. 直接解析（理想情况：模型严格只输出 JSON）
  const direct = tryParse(text);
  if (direct) return direct;

  // 2. 去掉 markdown 代码围栏后再试（```json ... ```）
  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const fromFence = tryParse(unfenced);
  if (fromFence) return fromFence;

  // 3. 从文本里抠出 JSON 对象。模型经常在 JSON 后面补一段解释，
  //    贪婪匹配会把尾巴一起吃进去导致解析失败，所以逐个候选尝试。
  const candidates = /\{[\s\S]*?\}/g;
  let m: RegExpExecArray | null;
  while ((m = candidates.exec(text)) !== null) {
    const parsed = tryParse(m[0]);
    if (parsed) return parsed;
  }

  return { speak: false };
}

function tryParse(text: string): InterjectVerdict | null {
  try {
    const obj = JSON.parse(text) as { speak?: unknown; opener?: unknown };
    if (typeof obj.speak !== 'boolean') return null;
    const opener = typeof obj.opener === 'string' ? obj.opener.trim() : undefined;
    return { speak: obj.speak, opener: opener && opener.length > 0 ? opener : undefined };
  } catch {
    return null;
  }
}

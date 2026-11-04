/**
 * 系统提示词里的时间锚点和搜索能力声明。
 *
 * 对应两个真实故障（2026-10-28）：
 *   1. 用户发标着「2026年10月27日」的截图，机器人说"这日期是未来的"——
 *      因为 prompt 只有 `现在是 10:32`，没有日期，模型只能按训练截止时间猜。
 *   2. 用户说「你再查查」，机器人回"我没法去联网翻新闻，刚才那波靠常识"——
 *      因为搜索没触发（正则不认"查查"），模型手上没资料，只能说查不到。
 */

import { describe, expect, it, vi } from 'vitest';
import { buildMessages } from '../src/core/prompt.js';
import { looksLikeSearchIntent } from '../src/core/web.js';
import type { MessageEvent } from '../src/core/types.js';

const persona = {
  id: 'whale',
  name: '鲸鱼酱',
  systemPrompt: '你叫鲸鱼酱。',
  replyMaxChars: 120,
  allowInterject: false,
  replyTechMaxChars: 300,
  replyRecapMaxChars: 600,
  replyDetailMaxChars: 1500,
} as never;

function makeEvent(ts: number, text = '你好'): MessageEvent {
  return {
    eventId: 'e1',
    scene: 'group',
    peerId: '888',
    peerName: '测试群',
    selfId: '10000',
    timestamp: ts,
    text,
    segments: [{ type: 'text', text }],
    sender: { userId: '1001', nickname: 'Hans' },
    atMe: true,
  } as MessageEvent;
}

function sysOf(msgs: Array<{ role: string; content: unknown }>): string {
  const sys = msgs.find((m) => m.role === 'system');
  return typeof sys?.content === 'string' ? sys.content : '';
}

describe('时间锚点', () => {
  it('系统提示里带完整日期', () => {
    // 2026-10-28 10:32 本地时间
    const ts = Math.floor(new Date(2026, 9, 28, 10, 32, 0).getTime() / 1000);
    const msgs = buildMessages({
      persona,
      event: makeEvent(ts),
      history: [],
      maxContextChars: 4000,
      botName: '鲸鱼酱',
    });

    const sys = sysOf(msgs as Array<{ role: string; content: unknown }>);
    expect(sys).toContain('2026年10月28日');
    expect(sys).toContain('10:32');
    expect(sys).toContain('星期三');
  });

  it('明确告知训练数据有截止时间', () => {
    const ts = Math.floor(Date.now() / 1000);
    const msgs = buildMessages({
      persona,
      event: makeEvent(ts),
      history: [],
      maxContextChars: 4000,
      botName: '鲸鱼酱',
    });
    const sys = sysOf(msgs as Array<{ role: string; content: unknown }>);
    expect(sys).toContain('训练数据有截止时间');
  });

  it('有搜索结果时不允许说"没法联网"', () => {
    const ts = Math.floor(Date.now() / 1000);
    const msgs = buildMessages({
      persona,
      event: makeEvent(ts, '这消息是真的吗'),
      history: [],
      maxContextChars: 4000,
      botName: '鲸鱼酱',
      searchBlock: '【联网搜索结果】关键词：测试\n[1] 某新闻',
    });
    const sys = sysOf(msgs as Array<{ role: string; content: unknown }>);
    expect(sys).toContain('不要说"我没法联网"');
  });
});

describe('搜索意图识别', () => {
  it('识别"再查查"这类追查', () => {
    expect(looksLikeSearchIntent('你再查查呢')).toBe(true);
    expect(looksLikeSearchIntent('再查一遍')).toBe(true);
    expect(looksLikeSearchIntent('再搜搜')).toBe(true);
    expect(looksLikeSearchIntent('查查这个')).toBe(true);
    expect(looksLikeSearchIntent('再确认一下')).toBe(true);
  });

  it('识别"正规媒体怎么没报道"这类间接查证', () => {
    expect(looksLikeSearchIntent('正规媒体怎么没报道')).toBe(true);
    expect(looksLikeSearchIntent('这消息来源是啥')).toBe(true);
  });

  it('普通聊天不触发', () => {
    expect(looksLikeSearchIntent('今天天气不错')).toBe(false);
    expect(looksLikeSearchIntent('说一句你好')).toBe(false);
    expect(looksLikeSearchIntent('唱首歌')).toBe(false);
  });

  it('带链接的不走搜索', () => {
    expect(looksLikeSearchIntent('查一下 https://example.com')).toBe(false);
  });
});

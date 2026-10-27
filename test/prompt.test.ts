import { describe, expect, it } from 'vitest';
import type { MessageEvent } from '../src/core/types.js';
import { FALLBACK_PERSONA } from '../src/core/persona.js';
import { buildMessages, renderHistory, sanitizeReply, trimToCharBudget } from '../src/core/prompt.js';
import type { StoredMessage } from '../src/core/memory.js';

function mkEvent(overrides: Partial<MessageEvent> = {}): MessageEvent {
  return {
    messageId: '1',
    eventId: 'e1',
    scene: 'group',
    peerId: '123456',
    peerName: '测试群',
    sender: { userId: '1001', nickname: '小明' },
    segments: [{ type: 'text', text: '你好' }],
    text: '你好',
    mentionsBot: true,
    fromSelf: false,
    timestamp: 1700000000,
    platform: 'qq',
    ...overrides,
  };
}

const history: StoredMessage[] = [
  {
    scene: 'group',
    peerId: '123456',
    userId: '1001',
    nickname: '小明',
    text: '今天好热',
    mentionsBot: false,
    fromSelf: false,
    timestamp: 1700000000,
  },
  {
    scene: 'group',
    peerId: '123456',
    userId: 'whale',
    nickname: 'whale',
    text: '是挺热的',
    mentionsBot: false,
    fromSelf: true,
    timestamp: 1700000010,
  },
];

describe('提示词拼装', () => {
  it('包含人设、规则与当前消息', () => {
    const messages = buildMessages({
      persona: FALLBACK_PERSONA,
      event: mkEvent(),
      history,
      maxContextChars: 6000,
      botName: '鲸鱼酱',
    });
    expect(messages).toHaveLength(2);
    const [system, user] = messages as [typeof messages[0], typeof messages[0]];
    expect(system.role).toBe('system');
    expect(system.content).toContain('鲸鱼酱');
    expect(system.content).toContain('不要提到自己是 AI');
    expect(system.content).toContain('测试群');
    expect(user.content).toContain('小明: 今天好热');
    expect(user.content).toContain('鲸鱼酱: 是挺热的');
    expect(user.content).toContain('小明: 你好');
  });

  it('私聊不出现群号', () => {
    const messages = buildMessages({
      persona: FALLBACK_PERSONA,
      event: mkEvent({ scene: 'private', peerId: '1001', text: '在吗' }),
      history: [],
      maxContextChars: 6000,
      botName: '鲸鱼酱',
    });
    const system = messages[0]?.content ?? '';
    expect(system).toContain('私聊');
    expect(system).not.toContain('群号');
  });

  it('历史按字符预算从尾部保留', () => {
    const lines = renderHistory(history, '鲸鱼酱');
    expect(trimToCharBudget(lines, 8)).toEqual(['鲸鱼酱: 是挺热的']);
    expect(trimToCharBudget(lines, 6000)).toHaveLength(2);
  });
});

describe('回复清洗', () => {
  it('去掉前缀与包裹引号', () => {
    expect(sanitizeReply('回复：你好呀', 100)).toBe('你好呀');
    expect(sanitizeReply('“你好呀”', 100)).toBe('你好呀');
  });

  it('去掉 markdown 粗体与反引号', () => {
    expect(sanitizeReply('**真的**吗 `code`', 100)).toBe('真的吗 code');
  });

  it('超长按字符上限截断并去掉尾部标点', () => {
    const out = sanitizeReply('啊'.repeat(50) + '，', 10);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out.endsWith('，')).toBe(false);
  });

  it('正常回复不被误伤', () => {
    expect(sanitizeReply('我觉得吧，这事得看情况。', 100)).toBe('我觉得吧，这事得看情况。');
  });

  // 回归：粗体与引号同时出现时，旧实现因顺序问题漏剥引号
  it('先剥 Markdown 再剥引号，混合场景也能清干净', () => {
    expect(sanitizeReply('**是挺热的**，"你也觉得吧"', 100)).toBe('是挺热的，你也觉得吧');
  });

  // 回归：旧实现会误删「注意：」「时间：」这类正常冒号前缀
  it('不误删正常的冒号前缀', () => {
    expect(sanitizeReply('注意：记得带伞', 100)).toBe('注意：记得带伞');
    expect(sanitizeReply('时间：8:30 集合', 100)).toBe('时间：8:30 集合');
  });

  it('剥掉句末成对引号装饰', () => {
    expect(sanitizeReply('可以啊，"那就这么定了"', 100)).toBe('可以啊，那就这么定了');
    expect(sanitizeReply('嗯，“行”', 100)).toBe('嗯，行');
  });

  it('保留句中对话引号，不做过度清洗', () => {
    expect(sanitizeReply('他说"你好"就走了', 100)).toBe('他说"你好"就走了');
    expect(sanitizeReply('「鲸鱼酱」说的话', 100)).toBe('「鲸鱼酱」说的话');
  });

  it('多层嵌套引号可逐层剥离', () => {
    expect(sanitizeReply('『层层嵌套』', 100)).toBe('层层嵌套');
  });
});

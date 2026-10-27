/**
 * 引用消息补全。
 *
 * 背景（2026-10-27 真实故障）：
 *   用户在私聊里引用一条消息说「你看看这个」，机器人回
 *   「你让我看啥，我这边啥也没收到，空空如也」。
 *
 *   根因：OneBot 的 reply 段只有 message_id，正文不在事件里。
 *   旧代码把它渲染成 `[回复]` 占位符，模型只看到「[回复]你看看这个」，
 *   完全不知道被引用的是什么。
 *
 *   修法：收到带 reply 段的消息时调 get_msg 拉一次被引用消息，拼进 text。
 */

import { describe, expect, it } from 'vitest';
import { renderPlainText, toInternalSegments } from '../src/adapters/onebot/segments.js';

const SELF = '1000000001';

describe('reply 段的渲染', () => {
  it('reply 段本身只渲染成占位符（这是补全前的状态）', () => {
    const segs = toInternalSegments([
      { type: 'reply', data: { id: '12345' } },
      { type: 'text', data: { text: '你看看这个' } },
    ]);
    const text = renderPlainText(segs, SELF);
    // 这一步只验证占位符存在——真实补全靠 adapter.enrichQuoted
    expect(text).toContain('[回复]');
    expect(text).toContain('你看看这个');
  });

  it('reply 段的 messageId 被正确解析', () => {
    const segs = toInternalSegments([{ type: 'reply', data: { id: '98765' } }]);
    const reply = segs.find((s) => s.type === 'reply');
    expect(reply).toBeDefined();
    if (reply?.type === 'reply') expect(reply.messageId).toBe('98765');
  });

  it('没有 id 的 reply 段不崩', () => {
    const segs = toInternalSegments([{ type: 'reply', data: {} }]);
    expect(segs.some((s) => s.type === 'reply')).toBe(true);
  });
});

describe('补全后的文本形态', () => {
  /**
   * 复刻 adapter.enrichQuoted 的替换逻辑，验证输出格式。
   * （真实实现要连 OneBot，这里只测文本拼装规则）
   */
  function applyQuote(text: string, who: string, inner: string): string {
    const prefix = who ? `[引用 ${who}：` : '[引用：';
    const snippet = inner.length > 300 ? `${inner.slice(0, 300)}…` : inner;
    return text.replace('[回复]', `${prefix}${snippet}]`);
  }

  it('占位符被替换成引用内容', () => {
    const before = '[回复]你看看这个';
    const after = applyQuote(before, '小明', '10月26日消息，幻萌网络人事行政组向公司内部发布讣告');
    expect(after).toContain('10月26日消息');
    expect(after).not.toContain('[回复]');
    expect(after).toContain('你看看这个');
  });

  it('带昵称', () => {
    const after = applyQuote('[回复]看看', '张三', '原消息内容');
    expect(after).toBe('[引用 张三：原消息内容]看看');
  });

  it('没昵称时降级', () => {
    const after = applyQuote('[回复]看看', '', '原消息内容');
    expect(after).toBe('[引用：原消息内容]看看');
  });

  it('超长引用被截断到 300 字', () => {
    const long = 'x'.repeat(500);
    const after = applyQuote('[回复]看看', '某人', long);
    // [引用 某人： + 300字 + …] + 看看
    expect(after).toContain('…');
    expect(after.length).toBeLessThan(320);
  });

  it('短引用不截断', () => {
    const after = applyQuote('[回复]看看', '某人', '短内容');
    expect(after).not.toContain('…');
  });
});

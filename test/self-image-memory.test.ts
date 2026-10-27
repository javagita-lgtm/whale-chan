/**
 * 验证：表情包发出后必须进记忆库，否则模型会误以为图是用户发的。
 *
 * 真群故障（2026-10-27）：
 *   机器人发了张图 → 用户问「你从哪找到这么色气的图」
 *   → 机器人回答「这图明明是你自己甩过来的」「贼喊捉贼」
 *   根因：maybeSendSticker 没把「我发了图」写进记忆，
 *        模型上下文里看不到这张图是自己发的。
 */

import { describe, expect, it } from 'vitest';
import { renderHistory } from '../src/core/prompt.js';
import type { StoredMessage } from '../src/core/types.js';

const BOT = '鲸鱼娘';

function msg(over: Partial<StoredMessage>): StoredMessage {
  return {
    id: 1,
    platform: 'onebot',
    scene: 'group',
    peerId: '123',
    userId: '1',
    nickname: '某人',
    text: 'hi',
    mentionsBot: false,
    fromSelf: false,
    timestamp: 0,
    ...over,
  } as StoredMessage;
}

describe('历史渲染能区分发图归属', () => {
  it('机器人发的图渲染成自己的名字', () => {
    const lines = renderHistory(
      [
        msg({ text: '在呢', fromSelf: true }),
        msg({ text: '（发了张表情包：蓝鲸娘）', fromSelf: true }),
        msg({ nickname: 'Hans Deemo', text: '你从哪找到这么色气的图' }),
      ],
      BOT,
    );
    expect(lines[1]).toContain(BOT);
    expect(lines[1]).toContain('表情包');
    expect(lines[2]).toContain('Hans Deemo');
  });

  it('修复后的历史里，模型能看到是自己发的图', () => {
    const lines = renderHistory(
      [
        msg({ text: '（发了张表情包：蓝鲸娘）', fromSelf: true }),
        msg({ nickname: 'Hans Deemo', text: '你从哪找到的图' }),
      ],
      BOT,
    );
    // 关键断言：发图那条的主语必须是机器人
    expect(lines[0]?.startsWith(BOT)).toBe(true);
    expect(lines[1]?.startsWith('Hans Deemo')).toBe(true);
  });

  it('修复前若缺记录，模型无法判断归属', () => {
    // 模拟修复前的历史：只有用户消息 + 一段无关文字，没有「我发了图」
    const lines = renderHistory(
      [msg({ nickname: 'Hans Deemo', text: '你从哪找到的图' })],
      BOT,
    );
    // 历史里没有任何一条提到"发了图"，模型只能瞎猜
    expect(lines.some((l) => l.includes('发了张'))).toBe(false);
  });

  it('生图记录也带机器人署名', () => {
    const lines = renderHistory(
      [msg({ text: '（发了张图：画个猫）', fromSelf: true })],
      BOT,
    );
    expect(lines[0]?.startsWith(BOT)).toBe(true);
  });
});

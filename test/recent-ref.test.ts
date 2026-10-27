/**
 * 「上面那个视频」这类指代：本条消息没有链接时，沿用最近历史里的链接。
 *
 * 真实场景：群里先单独发卡片（不 @，不触发回应），
 * 过一会儿再 @ 问"上面卡片里的视频说了什么"——这时本条只有文字。
 */

import { describe, expect, it } from 'vitest';

// 与 pipeline 内保持一致的指代正则（此处复刻一份用于单测）
const RECENT_REF_PATTERN =
  /(上面|上边|刚才|刚刚|之前|前面|那个|这条|这则|刚发|上一条).{0,8}(视频|链接|卡片|文章|内容|帖子|图|分享)/;

describe('指代上文的识别', () => {
  it('识别常见引用说法', () => {
    expect(RECENT_REF_PATTERN.test('上面卡片里的这个视频说了什么？')).toBe(true);
    expect(RECENT_REF_PATTERN.test('刚才那个视频讲了啥')).toBe(true);
    expect(RECENT_REF_PATTERN.test('上面那个链接看看')).toBe(true);
    expect(RECENT_REF_PATTERN.test('之前发的文章总结下')).toBe(true);
    expect(RECENT_REF_PATTERN.test('上一条视频说了什么')).toBe(true);
  });

  it('普通提问不误判', () => {
    expect(RECENT_REF_PATTERN.test('这个视频说了什么？')).toBe(false);
    expect(RECENT_REF_PATTERN.test('今天好累啊')).toBe(false);
    expect(RECENT_REF_PATTERN.test('帮我查一下天气')).toBe(false);
    expect(RECENT_REF_PATTERN.test('哈哈哈')).toBe(false);
  });
});

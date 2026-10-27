/**
 * 引用带图片的消息。
 *
 * 背景（2026-10-27）：
 *   用户引用一条图片消息问「这是啥」，机器人只看到 `[回复]`，
 *   图片本身也没送进视觉模型。
 *
 *   因为图片的 URL 在被引用的那条消息里，不在本条 segments 里。
 *   修法：enrichQuoted 时把图片 URL 单独提出来，放到 event.quotedImageUrls，
 *   collectImages 再把它合并进视觉输入。
 */

import { describe, expect, it } from 'vitest';
import { renderPlainText, toInternalSegments } from '../src/adapters/onebot/segments.js';

const SELF = '1000000001';

/** 复刻 adapter.enrichQuoted 里的提取逻辑。 */
function extractQuotedImages(rawSegs: Array<{ type: string; data?: Record<string, unknown> }>) {
  const segs = toInternalSegments(rawSegs as never);
  return segs
    .filter((s): s is { type: 'image'; url?: string; fileId?: string } => s.type === 'image')
    .map((s) => s.url)
    .filter((u): u is string => typeof u === 'string' && u.length > 0)
    .slice(0, 2);
}

describe('引用消息里的图片提取', () => {
  it('单图能提取', () => {
    const urls = extractQuotedImages([
      { type: 'image', data: { file: 'a.jpg', url: 'https://example.com/a.jpg' } },
      { type: 'text', data: { text: '这张图' } },
    ]);
    expect(urls).toEqual(['https://example.com/a.jpg']);
  });

  it('多图最多取 2 张', () => {
    const urls = extractQuotedImages([
      { type: 'image', data: { url: 'https://e.com/1.jpg' } },
      { type: 'image', data: { url: 'https://e.com/2.jpg' } },
      { type: 'image', data: { url: 'https://e.com/3.jpg' } },
    ]);
    expect(urls).toHaveLength(2);
  });

  it('没有 url 的图片被跳过', () => {
    const urls = extractQuotedImages([
      { type: 'image', data: { file: 'only-file.jpg' } },
      { type: 'image', data: { url: 'https://e.com/x.jpg' } },
    ]);
    expect(urls).toEqual(['https://e.com/x.jpg']);
  });

  it('纯文字消息提取为空', () => {
    const urls = extractQuotedImages([{ type: 'text', data: { text: '只有文字' } }]);
    expect(urls).toEqual([]);
  });

  it('图 + 文字混合的消息，文字仍正常渲染', () => {
    const segs = toInternalSegments([
      { type: 'image', data: { url: 'https://e.com/a.jpg' } },
      { type: 'text', data: { text: '这张图' } },
    ] as never);
    const text = renderPlainText(segs, SELF);
    expect(text).toContain('[图片]');
    expect(text).toContain('这张图');
  });
});

describe('合并顺序（本条图 → 引用图 → 卡片封面）', () => {
  it('按优先级排列，超出上限时截断', () => {
    const own = ['own1.jpg', 'own2.jpg'];
    const quoted = ['quoted1.jpg'];
    const covers = ['cover1.jpg'];
    const maxImages = 2;

    const all = [...own, ...quoted, ...covers].slice(0, maxImages);
    // 本条消息的图优先
    expect(all).toEqual(['own1.jpg', 'own2.jpg']);
    // 引用图被挤掉了——这是有意的：本条消息的图更直接
    expect(all).not.toContain('quoted1.jpg');
  });

  it('本条没有图时，引用图能进来', () => {
    const own: string[] = [];
    const quoted = ['quoted1.jpg'];
    const covers: string[] = [];
    const all = [...own, ...quoted, ...covers].slice(0, 2);
    expect(all).toEqual(['quoted1.jpg']);
  });

  it('都没图时返回空', () => {
    const all = [...[], ...[], ...[]].slice(0, 2);
    expect(all).toHaveLength(0);
  });
});

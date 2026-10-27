import { describe, expect, it } from 'vitest';
import {
  escapeCQ,
  parseCQCodes,
  renderPlainText,
  toInternalSegments,
  unescapeCQ,
} from '../src/adapters/onebot/segments.js';

describe('CQ 码解析', () => {
  it('解析纯文本', () => {
    const segs = parseCQCodes('你好呀');
    expect(segs).toEqual([{ type: 'text', data: { text: '你好呀' } }]);
  });

  it('解析 at 与图片，并保留顺序', () => {
    const segs = parseCQCodes('看这个[CQ:at,qq=12345] 图[CQ:image,file=a.jpg,url=https://x/y.jpg]');
    expect(segs.map((s) => s.type)).toEqual(['text', 'at', 'text', 'image']);
    const at = segs[1];
    expect(at?.data?.['qq']).toBe('12345');
    const img = segs[3];
    expect(img?.data?.['file']).toBe('a.jpg');
    expect(img?.data?.['url']).toBe('https://x/y.jpg');
  });

  it('转义与反转义可逆', () => {
    const raw = 'a&b[c,d]';
    expect(unescapeCQ(escapeCQ(raw))).toBe(raw);
  });

  it('CQ 参数值里的转义逗号不会截断', () => {
    const segs = parseCQCodes('[CQ:image,file=a&#44;b.jpg]');
    expect(segs[0]?.data?.['file']).toBe('a,b.jpg');
  });
});

describe('统一消息段渲染', () => {
  it('@ 自身渲染为标记，其他 @ 保留 QQ 号', () => {
    const segs = toInternalSegments([
      { type: 'text', data: { text: '  ' } },
      { type: 'at', data: { qq: '999' } },
      { type: 'text', data: { text: ' 在吗' } },
      { type: 'at', data: { qq: '888' } },
    ]);
    expect(renderPlainText(segs, '999')).toBe('[艾特你] 在吗@888');
  });

  it('图片与表情降级为占位文本', () => {
    const segs = toInternalSegments([
      { type: 'image', data: { file: 'x.jpg' } },
      { type: 'face', data: { id: '1' } },
      { type: 'forward', data: {} },
    ]);
    expect(renderPlainText(segs, '1')).toBe('[图片][表情][forward]');
  });
});

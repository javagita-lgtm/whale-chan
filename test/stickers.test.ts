import { describe, expect, it } from 'vitest';
import { expandQuery, queryGrams } from '../src/core/stickers.js';
import { extractStickerHint } from '../src/core/prompt.js';

describe('n-gram 切分', () => {
  it('切出 1~3 字片段并记录长度', () => {
    const g = queryGrams('吃白饭');
    expect(g.get('吃')).toBe(1);
    expect(g.get('吃白')).toBe(2);
    expect(g.get('吃白饭')).toBe(3);
  });

  it('过滤标点与空白', () => {
    const g = queryGrams('死掉了！');
    expect(g.has('死掉了')).toBe(true);
    expect(g.has('！')).toBe(false);
  });

  it('纯符号返回空', () => {
    expect(queryGrams('！？…').size).toBe(0);
  });
});

describe('查询扩展', () => {
  it('原词始终包含', () => {
    expect(expandQuery('你好')).toContain('你好');
  });

  it('口语「累」能扩展出「死掉了」等书面说法', () => {
    const v = expandQuery('好累啊');
    expect(v).toContain('死掉了');
    expect(v.some((x) => x.includes('摆烂') || x.includes('躺平'))).toBe(true);
  });

  it('未收录的词只返回原词', () => {
    expect(expandQuery('量子')).toEqual(['量子']);
  });

  it('空输入返回空数组', () => {
    expect(expandQuery('  ')).toEqual([]);
  });
});

describe('表情包提示提取', () => {
  it('抽出 hint 并剥离注释', () => {
    const raw = '今天真是累懵了\n<!--sticker: 累到宕机-->';
    const r = extractStickerHint(raw);
    expect(r.text).toBe('今天真是累懵了');
    expect(r.hint).toBe('累到宕机');
  });

  it('没有注释时原样返回', () => {
    const r = extractStickerHint('就是一句普通的话');
    expect(r.text).toBe('就是一句普通的话');
    expect(r.hint).toBeNull();
  });

  it('中文冒号也能识别', () => {
    const r = extractStickerHint('好的呀\n<!--sticker：开心得转圈-->');
    expect(r.hint).toBe('开心得转圈');
    expect(r.text).toBe('好的呀');
  });

  it('空注释返回 null', () => {
    const r = extractStickerHint('说话\n<!--sticker: -->');
    expect(r.hint).toBeNull();
  });

  it('不破坏正文中的其他 HTML 注释外的内容', () => {
    const r = extractStickerHint('前面 <!--普通注释--> 后面');
    expect(r.text).toBe('前面 <!--普通注释--> 后面');
    expect(r.hint).toBeNull();
  });
});

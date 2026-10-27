/**
 * 分享卡片封面图 + 错误页检测。
 *
 * 背景：小红书正文被风控挡住时，分享卡片里的封面图是唯一能看到的画面信息。
 */

import { describe, expect, it } from 'vitest';
import { parseShareCard, renderPlainText, toInternalSegments } from '../src/adapters/onebot/segments.js';

const base = {
  app: 'com.tencent.miniapp_01',
  meta: {
    detail_1: {
      title: '律师讲述上海独生女被吃绝户案例',
      desc: '父母去世后继承2亿遗产，新婚一年的丈夫以性格不合为由要求离婚并分割...',
      qqdocurl: 'https://www.xiaohongshu.com/discovery/item/6adc281f',
    },
  },
};

describe('分享卡片封面图', () => {
  it('从 preview 字段取封面', () => {
    const card = JSON.parse(JSON.stringify(base)) as typeof base & {
      meta: { detail_1: Record<string, unknown> };
    };
    card.meta.detail_1['preview'] = 'https://sns-webpic-qc.xhscdn.com/202510/sample.jpg';
    const r = parseShareCard('json', { data: JSON.stringify(card) });
    if (r?.type !== 'share') throw new Error('应解析为 share');
    expect(r.imageUrl).toBe('https://sns-webpic-qc.xhscdn.com/202510/sample.jpg');
  });

  it('从 thumburl 字段取封面', () => {
    const card = JSON.parse(JSON.stringify(base)) as typeof base & {
      meta: { detail_1: Record<string, unknown> };
    };
    card.meta.detail_1['thumburl'] = 'https://example.com/thumb.jpg';
    const r = parseShareCard('json', { data: JSON.stringify(card) });
    if (r?.type !== 'share') throw new Error('应解析');
    expect(r.imageUrl).toBe('https://example.com/thumb.jpg');
  });

  it('从 cover 字段取封面', () => {
    const card = JSON.parse(JSON.stringify(base)) as typeof base & {
      meta: { detail_1: Record<string, unknown> };
    };
    card.meta.detail_1['cover'] = 'https://example.com/cover.jpg';
    const r = parseShareCard('json', { data: JSON.stringify(card) });
    if (r?.type !== 'share') throw new Error('应解析');
    expect(r.imageUrl).toBe('https://example.com/cover.jpg');
  });

  it('没有封面字段时不报错', () => {
    const r = parseShareCard('json', { data: JSON.stringify(base) });
    if (r?.type !== 'share') throw new Error('应解析');
    expect(r.imageUrl).toBeUndefined();
    expect(r.title).toContain('吃绝户');
  });

  it('非 http 协议的封面被过滤', () => {
    const card = JSON.parse(JSON.stringify(base)) as typeof base & {
      meta: { detail_1: Record<string, unknown> };
    };
    card.meta.detail_1['preview'] = 'mqqapi://internal';
    const r = parseShareCard('json', { data: JSON.stringify(card) });
    if (r?.type !== 'share') throw new Error('应解析');
    expect(r.imageUrl).toBeUndefined();
  });

  it('XML 卡片也能取 thumburl', () => {
    const xml = `<msg><item><title>测试</title></item><thumburl>https://example.com/x.jpg</thumburl><url>https://a.com/1</url></msg>`;
    const r = parseShareCard('xml', { data: xml });
    if (r?.type !== 'share') throw new Error('应解析');
    expect(r.imageUrl).toBe('https://example.com/x.jpg');
  });
});

describe('封面图渲染提示', () => {
  it('有封面时文本里带提示', () => {
    const card = JSON.parse(JSON.stringify(base)) as typeof base & {
      meta: { detail_1: Record<string, unknown> };
    };
    card.meta.detail_1['preview'] = 'https://example.com/c.jpg';
    const segs = toInternalSegments([{ type: 'json', data: { data: JSON.stringify(card) } }]);
    const text = renderPlainText(segs, '1000000001');
    expect(text).toContain('卡片带封面图');
  });

  it('无封面时文本里没有提示', () => {
    const segs = toInternalSegments([{ type: 'json', data: { data: JSON.stringify(base) } }]);
    const text = renderPlainText(segs, '1000000001');
    expect(text).not.toContain('卡片带封面图');
  });
});

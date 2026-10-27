/**
 * QQ 分享卡片解析。
 *
 * 背景：QQ 里的 B 站分享卡片不是普通文本链接，正文在 json/xml 段里。
 * 不解析的话机器人只看到 "[json]" 三个字符，完全不知道分享的是什么。
 */

import { describe, expect, it } from 'vitest';
import { parseShareCard, renderPlainText, toInternalSegments } from '../src/adapters/onebot/segments.js';

const miniapp = {
  app: 'com.tencent.miniapp_01',
  meta: {
    detail_1: {
      appid: '1109937557',
      title: '肯德基下架吮指原味鸡？！肯德基全部乡镇门店正式开售原味…',
      desc: '哔哩哔哩',
      qqdocurl: 'https://b23.tv/AbCdEf1',
    },
  },
};

const structmsg = {
  app: 'com.tencent.structmsg',
  meta: {
    news: {
      title: '李敖确实厉害，看看他以前的说法',
      desc: '哔哩哔哩',
      jumpUrl: 'https://b23.tv/AmHywzI',
    },
  },
};

describe('JSON 卡片解析', () => {
  it('解析小程序卡片（qqdocurl）', () => {
    const r = parseShareCard('json', { data: JSON.stringify(miniapp) });
    expect(r?.type).toBe('share');
    if (r?.type !== 'share') return;
    expect(r.title).toContain('肯德基');
    expect(r.url).toBe('https://b23.tv/AbCdEf1');
    expect(r.desc).toBe('哔哩哔哩');
  });

  it('解析链接卡片（jumpUrl）', () => {
    const r = parseShareCard('json', { data: JSON.stringify(structmsg) });
    if (r?.type !== 'share') throw new Error('应解析为 share');
    expect(r.title).toContain('李敖');
    expect(r.url).toBe('https://b23.tv/AmHywzI');
  });

  it('data 已是对象也能处理', () => {
    const r = parseShareCard('json', { data: JSON.stringify({ meta: { news: { title: 'X', jumpUrl: 'https://a.com/1' } } }) });
    if (r?.type !== 'share') throw new Error('应解析');
    expect(r.url).toBe('https://a.com/1');
  });

  it('空 data 返回 null', () => {
    expect(parseShareCard('json', { data: '' })).toBeNull();
    expect(parseShareCard('json', {})).toBeNull();
  });

  it('坏 JSON 返回 null 而不抛异常', () => {
    expect(parseShareCard('json', { data: '{不是json' })).toBeNull();
  });

  it('没有标题也没有链接时返回 null', () => {
    expect(parseShareCard('json', { data: JSON.stringify({ app: 'x' }) })).toBeNull();
  });

  it('过滤非 http 的 scheme', () => {
    const r = parseShareCard('json', {
      data: JSON.stringify({ meta: { news: { title: '内部', jumpUrl: 'mqqapi://xxx' } } }),
    });
    if (r?.type !== 'share') throw new Error('应解析');
    expect(r.url).toBeUndefined();
    expect(r.title).toBe('内部');
  });

  it('标题里混着链接时能抠出来', () => {
    const r = parseShareCard('json', {
      data: JSON.stringify({ meta: { news: { title: '标题 https://b23.tv/Xyz 后缀' } } }),
    });
    if (r?.type !== 'share') throw new Error('应解析');
    expect(r.url).toBe('https://b23.tv/Xyz');
  });
});

describe('XML 卡片解析', () => {
  const xml = `<?xml version="1.0"?>
<msg serviceID="1" action="web" brief="[分享] 测试">
  <item layout="2"><title>测试标题</title><summary>这是描述</summary></item>
  <source name="哔哩哔哩" />
  <url>https://b23.tv/XyZ123</url>
</msg>`;

  it('解析标题、链接、描述', () => {
    const r = parseShareCard('xml', { data: xml });
    if (r?.type !== 'share') throw new Error('应解析');
    expect(r.title).toBe('测试标题');
    expect(r.url).toBe('https://b23.tv/XyZ123');
    expect(r.desc).toBe('这是描述');
  });

  it('CDATA 包裹能正确处理', () => {
    const r = parseShareCard('xml', {
      data: '<msg><item><title><![CDATA[带CDATA的标题]]></title></item><url>https://a.com/x</url></msg>',
    });
    if (r?.type !== 'share') throw new Error('应解析');
    expect(r.title).toBe('带CDATA的标题');
  });

  it('空 XML 返回 null', () => {
    expect(parseShareCard('xml', { data: '<msg></msg>' })).toBeNull();
  });
});

describe('渲染成纯文本', () => {
  const selfId = '1000000001';

  it('卡片渲染为 [分享]标题 链接', () => {
    const segs = toInternalSegments([{ type: 'json', data: { data: JSON.stringify(miniapp) } }]);
    const text = renderPlainText(segs, selfId);
    expect(text).toContain('[分享]');
    expect(text).toContain('肯德基');
    expect(text).toContain('https://b23.tv/AbCdEf1');
    // 不能再是占位符
    expect(text).not.toContain('[json]');
  });

  it('卡片 + 提问能拼在一起', () => {
    const segs = toInternalSegments([
      { type: 'json', data: { data: JSON.stringify(miniapp) } },
      { type: 'text', data: { text: ' 这个视频说了什么？' } },
    ]);
    const text = renderPlainText(segs, selfId);
    expect(text).toContain('肯德基');
    expect(text).toContain('这个视频说了什么');
  });

  it('无法解析的卡片仍降级为占位符（不丢消息）', () => {
    const segs = toInternalSegments([{ type: 'json', data: { data: '坏数据' } }]);
    expect(renderPlainText(segs, selfId)).toBe('[json]');
  });
});

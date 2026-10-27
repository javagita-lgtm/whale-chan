/**
 * 指代识别 + OG 兜底 + 错误页检测。
 *
 * 背景（2026-10-26 真实故障）：
 *   用户先发小红书卡片（10:15），2 分钟后问「看一下这里链接里的内容，总结一下」（10:17）。
 *   - 「这里」不在指代词表里 → 链接继承失效 → 机器人连链接都没抓
 *   - 且 DeepSeek /v1/tools/fetch 对小红书返回 404 → 需要自抓 HTML 兜底
 */

import { describe, expect, it } from 'vitest';
import { detectErrorPage, extractOpenGraph } from '../src/core/web.js';

/** 与 pipeline.ts 保持一致的指代正则（复刻一份用于单测）。 */
const RECENT_REF_PATTERN =
  /(上面|上边|刚才|刚刚|之前|前面|那个|这条|这则|这个|这里|这边|该|刚发|上一条|楼上)[^。！？\n]{0,10}(视频|链接|卡片|文章|内容|帖子|图|分享|url|地址)/i;

describe('指代识别（链接继承）', () => {
  it('识别「这里」这类新增说法', () => {
    // 这是真实失败案例
    expect(RECENT_REF_PATTERN.test('看一下这里链接里的内容，总结一下')).toBe(true);
    expect(RECENT_REF_PATTERN.test('总结一下这里的内容')).toBe(true);
    expect(RECENT_REF_PATTERN.test('这个卡片说了啥')).toBe(true);
    expect(RECENT_REF_PATTERN.test('刚才发的链接看看')).toBe(true);
    expect(RECENT_REF_PATTERN.test('楼上那个视频讲了什么')).toBe(true);
  });

  it('原有说法继续有效', () => {
    expect(RECENT_REF_PATTERN.test('上面那个视频讲了什么')).toBe(true);
    expect(RECENT_REF_PATTERN.test('之前那个链接')).toBe(true);
    expect(RECENT_REF_PATTERN.test('上一条分享看看')).toBe(true);
  });

  it('无关消息不误判', () => {
    expect(RECENT_REF_PATTERN.test('今天好累啊')).toBe(false);
    expect(RECENT_REF_PATTERN.test('画个猫')).toBe(false);
    expect(RECENT_REF_PATTERN.test('哈哈哈')).toBe(false);
  });

  it('跨句不误判（不能跨标点匹配）', () => {
    // 「这里」和「链接」中间隔了句号，不应该算指代
    expect(RECENT_REF_PATTERN.test('我在这里。链接发你了')).toBe(false);
  });
});

describe('OG 元信息解析', () => {
  it('优先取 og:title 而不是 <title>', () => {
    const html = `<html><head>
      <meta property="og:title" content="律师讲述上海独生女被吃绝户案例">
      <title>小红书 - 你访问的页面不见了</title>
    </head></html>`;
    expect(extractOpenGraph(html).title).toBe('律师讲述上海独生女被吃绝户案例');
  });

  it('attribute 顺序颠倒也能解析', () => {
    const html = '<meta content="内容在前" property="og:title">';
    expect(extractOpenGraph(html).title).toBe('内容在前');
  });

  it('没有 og 时退回 twitter: 再退回 <title>', () => {
    expect(extractOpenGraph('<meta name="twitter:title" content="TW">').title).toBe('TW');
    expect(extractOpenGraph('<title>只有标题</title>').title).toBe('只有标题');
  });

  it('解析 description 与 site_name', () => {
    const html = `
      <meta property="og:description" content="父母去世后继承2亿遗产">
      <meta property="og:site_name" content="小红书">`;
    const m = extractOpenGraph(html);
    expect(m.description).toBe('父母去世后继承2亿遗产');
    expect(m.siteName).toBe('小红书');
  });

  it('解码 HTML 实体', () => {
    const html = '<meta property="og:title" content="A &amp; B &quot;引号&quot; &lt;标签&gt;">';
    expect(extractOpenGraph(html).title).toBe('A & B "引号" <标签>');
  });

  it('数字实体也能解', () => {
    expect(extractOpenGraph('<meta property="og:title" content="&#20013;&#25991;">').title).toBe('中文');
    expect(extractOpenGraph('<meta property="og:title" content="&#x4e2d;&#x6587;">').title).toBe('中文');
  });

  it('完全没有元信息时返回空对象', () => {
    const m = extractOpenGraph('<html><body>纯内容</body></html>');
    expect(m.title).toBeUndefined();
    expect(m.description).toBeUndefined();
  });
});

describe('错误页检测', () => {
  it('URL 指向 /404 时判定为错误页', () => {
    expect(detectErrorPage('<html></html>', 'https://x.com/404?source=/404')).toBeTruthy();
  });

  it('URL 带 error_msg 时提取原因', () => {
    const r = detectErrorPage(
      '<html></html>',
      'https://x.com/404?error_code=300031&error_msg=%E5%BD%93%E5%89%8D%E7%AC%94%E8%AE%B0%E6%9A%82%E6%97%B6%E6%97%A0%E6%B3%95%E6%B5%8F%E8%A7%88',
    );
    expect(r).toContain('当前笔记暂时无法浏览');
  });

  it('内容里出现「页面不见了」也判定', () => {
    expect(detectErrorPage('<html><title>小红书 - 你访问的页面不见了</title></html>')).toBeTruthy();
  });

  it('识别需要登录的页面', () => {
    expect(detectErrorPage('<html><body>请登录后查看</body></html>')).toBeTruthy();
  });

  it('识别访问受限', () => {
    expect(detectErrorPage('<html><body>访问过于频繁，请稍后再试</body></html>')).toBeTruthy();
  });

  it('正常页面不误判', () => {
    const ok = '<html><head><meta property="og:title" content="正常文章"></head><body>正文内容</body></html>';
    expect(detectErrorPage(ok, 'https://x.com/article/123')).toBeNull();
  });
});

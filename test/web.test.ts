/**
 * 网页能力：链接提取、搜索意图识别、结果渲染。
 *
 * 这些是纯函数，不联网也能测；真实接口的行为另用脚本验证。
 */

import { describe, expect, it } from 'vitest';
import {
  extractUrls,
  isReadableUrl,
  looksLikeSearchIntent,
  renderFetchedPages,
  renderSearchHits,
  WebTools,
  type FetchedPage,
} from '../src/core/web.js';
import { createLogger } from '../src/core/logger.js';

const silentLogger = createLogger('web-test');
silentLogger.setLevel?.('error');

describe('链接提取', () => {
  it('提取普通链接', () => {
    expect(extractUrls('看这个 https://example.com/a 挺好')).toEqual(['https://example.com/a']);
  });

  it('去掉链接末尾的中文标点', () => {
    expect(extractUrls('见 https://example.com/x。')).toEqual(['https://example.com/x']);
    expect(extractUrls('链接：https://example.com/y，真不错')).toEqual(['https://example.com/y']);
  });

  it('多条链接按出现顺序', () => {
    const urls = extractUrls('a https://one.com/1 b https://two.com/2');
    expect(urls).toEqual(['https://one.com/1', 'https://two.com/2']);
  });

  it('去重', () => {
    expect(extractUrls('https://a.com/x https://a.com/x')).toEqual(['https://a.com/x']);
  });

  it('遵守条数上限', () => {
    const text = 'https://a.com/1 https://b.com/2 https://c.com/3';
    expect(extractUrls(text, 2)).toHaveLength(2);
  });

  it('没有链接时返回空数组', () => {
    expect(extractUrls('今天天气不错')).toEqual([]);
  });
});

describe('链接可读性判断', () => {
  it('普通网页可读', () => {
    expect(isReadableUrl('https://example.com/article')).toBe(true);
    expect(isReadableUrl('https://www.bilibili.com/video/BV1xx')).toBe(true);
  });

  it('图片/视频/压缩包不可读', () => {
    expect(isReadableUrl('https://example.com/a.jpg')).toBe(false);
    expect(isReadableUrl('https://example.com/b.mp4')).toBe(false);
    expect(isReadableUrl('https://example.com/c.zip')).toBe(false);
    expect(isReadableUrl('https://example.com/d.pdf')).toBe(false);
  });

  it('非 http(s) 拒绝', () => {
    expect(isReadableUrl('ftp://example.com/a')).toBe(false);
    expect(isReadableUrl('javascript:alert(1)')).toBe(false);
    expect(isReadableUrl('不是链接')).toBe(false);
  });
});

describe('搜索意图识别', () => {
  it('明确的查/搜请求触发', () => {
    expect(looksLikeSearchIntent('帮我查一下明天天气')).toBe(true);
    expect(looksLikeSearchIntent('搜一下 DeepSeek 新模型')).toBe(true);
    expect(looksLikeSearchIntent('最近有什么新闻')).toBe(true);
    expect(looksLikeSearchIntent('这个多少钱')).toBe(true);
  });

  it('普通闲聊不触发', () => {
    expect(looksLikeSearchIntent('今天好累啊')).toBe(false);
    expect(looksLikeSearchIntent('哈哈哈')).toBe(false);
    expect(looksLikeSearchIntent('早安')).toBe(false);
  });

  it('带链接的消息不触发搜索（要看的是链接不是搜索）', () => {
    expect(looksLikeSearchIntent('查一下这个 https://example.com/a')).toBe(false);
  });
});

describe('搜索结果渲染', () => {
  it('包含标题、来源、摘要和防幻觉指令', () => {
    const text = renderSearchHits(
      [
        { title: '标题一', url: 'https://a.com', summary: '摘要一', date: '2026-01-02T00:00:00Z' },
        { title: '标题二', url: 'https://b.com', summary: '摘要二', date: null },
      ],
      '测试词',
    );
    expect(text).toContain('测试词');
    expect(text).toContain('标题一');
    expect(text).toContain('https://a.com');
    expect(text).toContain('摘要一');
    expect(text).toContain('2026-01-02');
    // 必须带"不要编造"的约束，否则模型容易把搜索结果当万能答案
    expect(text).toContain('不要编造');
  });

  it('空结果返回空字符串', () => {
    expect(renderSearchHits([], 'x')).toBe('');
  });
});

describe('网页内容渲染', () => {
  const page: FetchedPage = {
    url: 'https://example.com/a',
    title: '示例文章',
    content: '# 正文\n这里是内容。',
    truncated: false,
  };

  it('包含标题、地址与正文', () => {
    const text = renderFetchedPages([page]);
    expect(text).toContain('示例文章');
    expect(text).toContain('https://example.com/a');
    expect(text).toContain('这里是内容');
  });

  it('明确告知模型"看不到画面不要假装看过"', () => {
    const text = renderFetchedPages([page]);
    expect(text).toContain('不要假装看过');
  });

  it('空列表返回空字符串', () => {
    expect(renderFetchedPages([])).toBe('');
  });
});

describe('WebTools 无 Key 时安全降级', () => {
  it('未配置 Key 时 enabled=false 且不发请求', async () => {
    const web = new WebTools({ apiKey: '', logger: silentLogger });
    expect(web.enabled).toBe(false);
    expect(await web.fetchPage('https://example.com')).toBeNull();
    expect(await web.search('测试')).toEqual([]);
  });

  it('不可读的 URL 直接返回 null，不消耗配额', async () => {
    const web = new WebTools({ apiKey: 'fake', logger: silentLogger });
    expect(await web.fetchPage('https://example.com/a.jpg')).toBeNull();
  });
});

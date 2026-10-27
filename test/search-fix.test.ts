/**
 * 联网搜索的两个真实 bug。
 *
 * 【bug 1，2026-10-27】baseUrl 双重 /v1
 *   .env 里 LLM_BASE_URL=https://api.deepseek.com/v1
 *   WebTools 内部路径是 /v1/tools/search
 *   拼出来 /v1/v1/tools/search → 404
 *   → 联网搜索从来没成功过，机器人拿到的永远是"无结果"
 *
 * 【bug 2，2026-10-27】搜索词没做指代消解
 *   用户问「他爹还在吗」，直接搜这句会返回「给爸爸上香」这类无关内容
 *   → 机器人据此说"没证据证明杨少华去世"
 *   而搜「杨少华」时 10 条结果全是他的去世报道
 */

import { describe, expect, it } from 'vitest';
import { renderSearchHits, type SearchHit } from '../src/core/web.js';

describe('baseUrl 归一化（bug 1）', () => {
  /** 复刻 WebTools 构造函数里的归一化逻辑。 */
  function normalizeBaseUrl(input: string | undefined): string {
    let base = (input ?? 'https://api.deepseek.com').replace(/\/+$/, '');
    base = base.replace(/\/v1$/i, '');
    return base;
  }

  it('带 /v1 的会被剥掉', () => {
    expect(normalizeBaseUrl('https://api.deepseek.com/v1')).toBe('https://api.deepseek.com');
  });

  it('不带的保持原样', () => {
    expect(normalizeBaseUrl('https://api.deepseek.com')).toBe('https://api.deepseek.com');
  });

  it('带尾部斜杠 + /v1 也能处理', () => {
    expect(normalizeBaseUrl('https://api.deepseek.com/v1/')).toBe('https://api.deepseek.com');
  });

  it('大小写不敏感', () => {
    expect(normalizeBaseUrl('https://api.deepseek.com/V1')).toBe('https://api.deepseek.com');
  });

  it('自定义域名同样处理', () => {
    expect(normalizeBaseUrl('https://my-proxy.example.com/v1')).toBe('https://my-proxy.example.com');
  });

  it('拼接后不会出现双重 /v1', () => {
    const base = normalizeBaseUrl('https://api.deepseek.com/v1');
    expect(`${base}/v1/tools/search`).toBe('https://api.deepseek.com/v1/tools/search');
    expect(`${base}/v1/tools/search`).not.toContain('/v1/v1/');
  });
});

describe('搜索词指代消解（bug 2）', () => {
  /** 复刻 buildSearchQuery 里的"是否需要消解"判断。 */
  function needsResolve(text: string): boolean {
    return /(他|她|它|这个|那个|这人|那位|上面|刚才|前者|后者)/.test(text);
  }

  it('含代词的会触发消解', () => {
    expect(needsResolve('他爹还在吗')).toBe(true);
    expect(needsResolve('这个人是谁')).toBe(true);
    expect(needsResolve('刚才那个新闻')).toBe(true);
  });

  it('无代词的不触发（省一次 LLM 调用）', () => {
    expect(needsResolve('杨少华是谁')).toBe(false);
    expect(needsResolve('今天天气怎么样')).toBe(false);
  });

  it('「它」这种也会误触发——可接受', () => {
    // 「其他」里含「他」，会多花一次 LLM 调用，但不会出错
    expect(needsResolve('其他国家的情况')).toBe(true);
  });
});

describe('搜索结果渲染', () => {
  const hits: SearchHit[] = [
    {
      title: '杨少华逝世 这一次没等来辟谣视频',
      url: 'https://example.com/1',
      summary: '94岁杨少华逝世',
      date: '2025-07-10T00:00:00+08:00',
      site: '现代快报',
    },
    {
      title: '相声演员杨少华去世',
      url: 'https://example.com/2',
      summary: '享年94岁',
      site: '央广网',
    },
  ];

  it('渲染出站点名', () => {
    const text = renderSearchHits(hits, '杨少华 现状');
    expect(text).toContain('现代快报');
    expect(text).toContain('央广网');
  });

  it('渲染出标题、来源、摘要', () => {
    const text = renderSearchHits(hits, '杨少华');
    expect(text).toContain('杨少华逝世');
    expect(text).toContain('https://example.com/1');
    expect(text).toContain('94岁杨少华逝世');
  });

  it('有日期时显示', () => {
    const text = renderSearchHits(hits, 'q');
    expect(text).toContain('2025-07-10');
  });

  it('没有 site 时不报错', () => {
    const noSite: SearchHit[] = [{ title: 'T', url: 'https://e.com', summary: 'S' }];
    const text = renderSearchHits(noSite, 'q');
    expect(text).toContain('T');
  });

  it('空结果返回空字符串', () => {
    expect(renderSearchHits([], 'q')).toBe('');
  });

  it('带关键词与结束标记', () => {
    const text = renderSearchHits(hits, '杨少华 现状');
    expect(text).toContain('【联网搜索结果】关键词：杨少华 现状');
    expect(text).toContain('【结果结束】');
  });
});

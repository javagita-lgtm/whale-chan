/**
 * 多源交叉验证：去重、证据评估、搜索词扩展、渲染。
 *
 * 这些都是纯函数，不碰网络。
 */

import { describe, expect, it } from 'vitest';
import {
  assessEvidence,
  dedupeHits,
  normalizeDate,
  renderCrossCheck,
  siteOf,
  type CrossCheckResult,
} from '../src/core/cross-check.js';
import { expandQueries } from '../src/core/pipeline/cross-checker.js';
import type { SearchHit } from '../src/core/web.js';

function hit(url: string, title: string, summary = '', date: string | null = null): SearchHit {
  return { url, title, summary, date, site: siteOf(url) };
}

describe('日期归一化', () => {
  it('ISO 格式', () => {
    expect(normalizeDate('2026-10-27')).toBe('2026-10-27');
    expect(normalizeDate('2026-10-27T10:00:00Z')).toBe('2026-10-27');
  });

  it('斜杠格式', () => {
    expect(normalizeDate('2026/10/7')).toBe('2026-10-07');
  });

  it('中文格式', () => {
    expect(normalizeDate('2026年10月27日')).toBe('2026-10-27');
    expect(normalizeDate('2026年1月5日')).toBe('2026-01-05');
  });

  it('无法识别返回 null', () => {
    expect(normalizeDate(null)).toBeNull();
    expect(normalizeDate('')).toBeNull();
    expect(normalizeDate('昨天')).toBeNull();
  });
});

describe('去重', () => {
  it('相同 URL 只留一条', () => {
    const hits = [
      hit('https://a.com/1', 'A'),
      hit('https://a.com/1?utm=x', 'A 副标题'),
      hit('https://b.com/1', 'B'),
    ];
    expect(dedupeHits(hits).length).toBe(2);
  });

  it('相同标题只留一条', () => {
    const hits = [
      hit('https://a.com/1', '同一条新闻'),
      hit('https://b.com/2', '同一条新闻'),
    ];
    expect(dedupeHits(hits).length).toBe(1);
  });

  it('协议和尾斜杠不影响', () => {
    const hits = [
      hit('http://a.com/x/', 'A'),
      hit('https://a.com/x', 'A2'),
    ];
    expect(dedupeHits(hits).length).toBe(1);
  });

  it('不同内容都保留', () => {
    const hits = [
      hit('https://a.com/1', 'A'),
      hit('https://b.com/2', 'B'),
      hit('https://c.com/3', 'C'),
    ];
    expect(dedupeHits(hits).length).toBe(3);
  });
});

describe('站点提取', () => {
  it('去 www', () => {
    expect(siteOf('https://www.xinhuanet.com/a')).toBe('xinhuanet.com');
    expect(siteOf('https://news.sina.com.cn/x')).toBe('news.sina.com.cn');
  });

  it('无效 URL 返回空', () => {
    expect(siteOf('')).toBe('');
    expect(siteOf('not a url')).toBe('');
  });
});

describe('证据评估', () => {
  it('多站点 + 权威媒体 = strong', () => {
    const hits = [
      hit('https://www.xinhuanet.com/a', '新闻1', '', '2026-10-27'),
      hit('https://news.sina.com.cn/b', '新闻2', '', '2026-10-27'),
      hit('https://www.thepaper.cn/c', '新闻3', '', '2026-10-26'),
    ];
    const r = assessEvidence(hits);
    expect(r.siteCount).toBe(3);
    expect(r.strength).toBe('strong');
    expect(r.earliest).toBe('2026-10-26');
    expect(r.latest).toBe('2026-10-27');
  });

  it('全是论坛 = weak', () => {
    const hits = [
      hit('https://tieba.baidu.com/1', '帖子1'),
      hit('https://weibo.com/2', '帖子2'),
    ];
    const r = assessEvidence(hits);
    expect(r.strength).toBe('weak');
  });

  it('只有一个站点 = weak', () => {
    const hits = [
      hit('https://a.com/1', 'A'),
      hit('https://a.com/2', 'B'),
      hit('https://a.com/3', 'C'),
    ];
    expect(assessEvidence(hits).strength).toBe('weak');
  });

  it('多站点但没有权威源 = medium', () => {
    const hits = [
      hit('https://blog1.com/a', 'A'),
      hit('https://blog2.com/b', 'B'),
      hit('https://blog3.com/c', 'C'),
    ];
    expect(assessEvidence(hits).strength).toBe('medium');
  });

  it('检测到辟谣说法 → conflicting', () => {
    const hits = [
      hit('https://a.com/1', '某消息是真的'),
      hit('https://b.com/2', '辟谣：某消息不实'),
      hit('https://c.com/3', '第三条'),
    ];
    expect(assessEvidence(hits).conflicting).toBe(true);
  });

  it('只有辟谣没有对立面时不算冲突', () => {
    // 全部都是辟谣类标题：结论一致（都是假的），不构成"说法不一致"
    const hits = [
      hit('https://a.com/1', '辟谣：这是假消息'),
      hit('https://b.com/2', '谣言：不实信息'),
    ];
    // denyCount=2, hits.length=2，两个相等所以不算 conflicting
    expect(assessEvidence(hits).conflicting).toBe(false);
  });
});

describe('搜索词扩展', () => {
  it('保留原查询', () => {
    expect(expandQueries('胡塞武装袭击沙特')).toContain('胡塞武装袭击沙特');
  });

  it('剔除质疑词', () => {
    const q = expandQueries('这消息真的假的 胡塞武装');
    expect(q.some((x) => x.includes('胡塞武装') && !x.includes('真的假的'))).toBe(true);
  });

  it('加反面证据角度', () => {
    const q = expandQueries('胡塞武装');
    expect(q.some((x) => x.includes('官方') || x.includes('通报'))).toBe(true);
  });

  it('空查询返回空', () => {
    expect(expandQueries('')).toEqual([]);
  });

  it('去重', () => {
    const q = expandQueries('测试');
    expect(new Set(q).size).toBe(q.length);
  });
});

describe('渲染', () => {
  const base: CrossCheckResult = {
    hits: [
      hit('https://www.xinhuanet.com/a', '新闻标题', '摘要内容', '2026-10-27'),
    ],
    queries: ['查询1', '查询2'],
    siteCount: 1,
    earliest: '2026-10-27',
    latest: '2026-10-27',
    conflicting: false,
    strength: 'weak',
    note: '证据薄弱。',
  };

  it('包含搜索词和结果', () => {
    const text = renderCrossCheck(base);
    expect(text).toContain('查询1');
    expect(text).toContain('新闻标题');
    expect(text).toContain('证据评估');
    expect(text).toContain('证据薄弱');
  });

  it('空结果返回空串', () => {
    expect(renderCrossCheck({ ...base, hits: [] })).toBe('');
  });

  it('strong 时措辞更确定', () => {
    const text = renderCrossCheck({ ...base, strength: 'strong', note: '证据充分。' });
    expect(text).toContain('证据充分');
  });
});

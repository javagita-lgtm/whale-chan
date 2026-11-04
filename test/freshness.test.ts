/**
 * 时效排序与标注。
 *
 * 背景（2026-10-28）：搜索接口返回的是**相关性**排序，不是时间排序。
 * 实测搜「胡塞武装 沙特」时，2026-03-18 的旧闻排在 2026-10-25 的新闻前面。
 * 如果模型引用旧闻当现状，结论就错了。
 *
 * 所以：按日期倒序排 + 每条标注「多久以前」，
 * 并在有旧闻混入时明确提醒模型不要当成"最近"。
 */

import { describe, expect, it } from 'vitest';
import {
  ageInDays,
  freshnessLabel,
  rankByDate,
  renderCrossCheck,
  todayStr,
  type CrossCheckResult,
} from '../src/core/cross-check.js';
import type { SearchHit } from '../src/core/web.js';

function hit(url: string, title: string, date: string | null = null): SearchHit {
  return { url, title, summary: '', date };
}

// 固定"今天"为 2026-10-28，让测试不随真实时间漂移
const TODAY = '2026-10-28';

describe('时效标签', () => {
  it('当天', () => {
    expect(freshnessLabel('2026-10-28', TODAY)).toBe('今天的报道');
  });

  it('昨天', () => {
    expect(freshnessLabel('2026-10-27', TODAY)).toBe('昨天的报道');
  });

  it('几天前', () => {
    expect(freshnessLabel('2026-10-25', TODAY)).toBe('3 天前');
    expect(freshnessLabel('2026-10-22', TODAY)).toBe('6 天前');
  });

  it('几周前', () => {
    expect(freshnessLabel('2026-10-14', TODAY)).toBe('2 周前');
    expect(freshnessLabel('2026-10-01', TODAY)).toBe('3 周前');
  });

  it('几个月前', () => {
    expect(freshnessLabel('2026-07-28', TODAY)).toBe('3 个月前');
    expect(freshnessLabel('2026-03-18', TODAY)).toBe('7 个月前');
  });

  it('一年多前', () => {
    expect(freshnessLabel('2025-10-28', TODAY)).toBe('1 年前');
    expect(freshnessLabel('2024-06-28', TODAY)).toBe('2 年 4 个月前');
  });

  it('未来日期单独提示', () => {
    expect(freshnessLabel('2026-12-01', TODAY)).toBe('日期在未来，可能不可靠');
  });

  it('无日期', () => {
    expect(freshnessLabel(null, TODAY)).toBe('时间不详');
    expect(freshnessLabel('不是日期', TODAY)).toBe('时间不详');
  });
});

describe('年龄计算', () => {
  it('算出天数', () => {
    expect(ageInDays('2026-10-28', TODAY)).toBe(0);
    expect(ageInDays('2026-10-21', TODAY)).toBe(7);
    expect(ageInDays('2026-03-18', TODAY)).toBe(224);
  });

  it('无日期返回 null', () => {
    expect(ageInDays(null, TODAY)).toBeNull();
  });
});

describe('按日期倒序排', () => {
  it('新的排前面', () => {
    const hits = [
      hit('https://a.com/1', '旧闻', '2026-03-18'),
      hit('https://b.com/2', '新闻', '2026-10-25'),
      hit('https://c.com/3', '中间', '2026-07-01'),
    ];
    const r = rankByDate(hits, TODAY);
    expect(r.map((h) => h.title)).toEqual(['新闻', '中间', '旧闻']);
  });

  it('无日期的排最后', () => {
    const hits = [
      hit('https://a.com/1', '没日期', null),
      hit('https://b.com/2', '有日期', '2026-10-25'),
    ];
    const r = rankByDate(hits, TODAY);
    expect(r[0]?.title).toBe('有日期');
    expect(r[1]?.title).toBe('没日期');
  });

  it('同日期保持原顺序（稳定排序）', () => {
    const hits = [
      hit('https://a.com/1', 'A', '2026-10-25'),
      hit('https://b.com/2', 'B', '2026-10-25'),
      hit('https://c.com/3', 'C', '2026-10-25'),
    ];
    const r = rankByDate(hits, TODAY);
    expect(r.map((h) => h.title)).toEqual(['A', 'B', 'C']);
  });

  it('附带时效标签', () => {
    const hits = [hit('https://a.com/1', '新闻', '2026-10-25')];
    const r = rankByDate(hits, TODAY);
    expect(r[0]?.freshness).toBe('3 天前');
    expect(r[0]?.ageDays).toBe(3);
    expect(r[0]?.normalizedDate).toBe('2026-10-25');
  });

  it('不修改原数组', () => {
    const hits = [hit('https://a.com/1', 'A', '2026-03-01'), hit('https://b.com/2', 'B', '2026-10-25')];
    const copy = [...hits];
    rankByDate(hits, TODAY);
    expect(hits).toEqual(copy);
  });
});

describe('渲染带时效', () => {
  const base: CrossCheckResult = {
    hits: rankByDate(
      [
        hit('https://www.xinhuanet.com/a', '最新新闻', '2026-10-25'),
        hit('https://blog.com/b', '很久以前', '2026-03-18'),
      ],
      TODAY,
    ),
    queries: ['测试'],
    siteCount: 2,
    earliest: '2026-03-18',
    latest: '2026-10-25',
    conflicting: false,
    strength: 'medium',
    note: '证据情况：2 个不同来源。',
  };

  it('每条带日期和时效', () => {
    const text = renderCrossCheck(base);
    expect(text).toContain('2026-10-25，3 天前');
    expect(text).toContain('2026-03-18，7 个月前');
  });

  it('声明按时间排序', () => {
    const text = renderCrossCheck(base);
    expect(text).toContain('按发布时间从新到旧排列');
  });

  it('有旧闻时给出警告', () => {
    const text = renderCrossCheck(base);
    expect(text).toContain('混有较早的报道');
    expect(text).toContain('不要把几个月前的消息说成"最近"');
  });

  it('全是新报道时不警告', () => {
    const fresh: CrossCheckResult = {
      ...base,
      hits: rankByDate([hit('https://a.com/1', '新', '2026-10-27')], TODAY),
    };
    const text = renderCrossCheck(fresh);
    expect(text).not.toContain('混有较早的报道');
  });

  it('无日期的显示"时间不详"', () => {
    const noDate: CrossCheckResult = {
      ...base,
      hits: rankByDate([hit('https://a.com/1', '无日期', null)], TODAY),
    };
    expect(renderCrossCheck(noDate)).toContain('时间不详');
  });
});

describe('todayStr', () => {
  it('返回 YYYY-MM-DD 格式', () => {
    expect(todayStr()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

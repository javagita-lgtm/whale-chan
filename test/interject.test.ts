/**
 * 主动插话（攒批判断）测试。
 *
 * 核心要验证的成本控制：
 *   - 未达阈值前**不调用模型**（这是省钱的关键）
 *   - 全局关闭 / 不在白名单群时完全不记录
 *   - 冷却、小时上限、概率闸都能拦住
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/core/memory.js';
import { createLogger } from '../src/core/logger.js';
import {
  InterjectObserver,
  checkInterjectGate,
  recordInterject,
  DEFAULT_POLICY,
  type InterjectPolicy,
} from '../src/core/interject.js';
import { buildInterjectMessages, parseInterjectVerdict } from '../src/core/interject-prompt.js';
import type { MessageEvent } from '../src/core/types.js';

const logger = createLogger('test');

function mkEvent(overrides: Partial<MessageEvent> = {}): MessageEvent {
  return {
    messageId: String(Math.random()),
    eventId: 'e1',
    scene: 'group',
    peerId: '123456',
    sender: { userId: '1001', nickname: '小明' },
    segments: [{ type: 'text', text: '聊天内容' }],
    text: '聊天内容',
    mentionsBot: false,
    fromSelf: false,
    timestamp: 1700000000,
    platform: 'qq',
    ...overrides,
  };
}

let dir: string;
let store: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wc-interject-'));
  store = new MemoryStore(dir, logger);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const policy: InterjectPolicy = {
  enabled: true,
  minMessages: 3,
  maxWaitMs: 60_000,
  cooldownMs: 600_000,
  maxPerHour: 4,
  rate: 1.0,
};

describe('观察器攒批', () => {
  it('未达阈值不触发判断', () => {
    const o = new InterjectObserver();
    expect(o.observe(mkEvent(), policy)).toBe(false);
    expect(o.observe(mkEvent(), policy)).toBe(false);
    expect(o.pending('qq', '123456')).toBe(2);
  });

  it('达到 minMessages 时触发', () => {
    const o = new InterjectObserver();
    o.observe(mkEvent(), policy);
    o.observe(mkEvent(), policy);
    expect(o.observe(mkEvent(), policy)).toBe(true);
  });

  it('超时未攒够也触发', () => {
    const o = new InterjectObserver();
    const t0 = 1_000_000;
    o.observe(mkEvent(), policy, t0);
    const later = t0 + policy.maxWaitMs + 1;
    expect(o.observe(mkEvent(), policy, later)).toBe(true);
  });

  it('take 后缓冲清空', () => {
    const o = new InterjectObserver();
    o.observe(mkEvent(), policy);
    const batch = o.take('qq', '123456');
    expect(batch?.events).toHaveLength(1);
    expect(o.pending('qq', '123456')).toBe(0);
    expect(o.take('qq', '123456')).toBeNull();
  });

  it('不同群互不干扰', () => {
    const o = new InterjectObserver();
    o.observe(mkEvent({ peerId: 'A' }), policy);
    o.observe(mkEvent({ peerId: 'A' }), policy);
    o.observe(mkEvent({ peerId: 'B' }), policy);
    expect(o.pending('qq', 'A')).toBe(2);
    expect(o.pending('qq', 'B')).toBe(1);
  });

  it('discard 可丢弃缓冲', () => {
    const o = new InterjectObserver();
    o.observe(mkEvent(), policy);
    o.discard('qq', '123456');
    expect(o.pending('qq', '123456')).toBe(0);
  });
});

describe('节流闸', () => {
  it('全局关闭时直接拒绝', () => {
    const g = checkInterjectGate(store, mkEvent(), { ...policy, enabled: false });
    expect(g).toEqual({ allow: false, reason: 'disabled' });
  });

  it('正常情况放行', () => {
    const g = checkInterjectGate(store, mkEvent(), policy);
    expect(g.allow).toBe(true);
  });

  it('冷却期内拒绝', () => {
    const e = mkEvent();
    recordInterject(store, e);
    const g = checkInterjectGate(store, e, policy);
    expect(g).toEqual({ allow: false, reason: 'cooldown' });
  });

  it('冷却结束后恢复', () => {
    const e = mkEvent();
    const t0 = Date.now();
    recordInterject(store, e, t0);
    const g = checkInterjectGate(store, e, policy, Math.random, t0 + policy.cooldownMs + 1);
    expect(g.allow).toBe(true);
  });

  it('每小时上限生效', () => {
    const e = mkEvent();
    const t0 = Date.now();
    // 塞满配额（注意每次 record 也会刷新冷却，这里只看小时计数）
    for (let i = 0; i < policy.maxPerHour; i++) recordInterject(store, e, t0 + i);
    const cfg: InterjectPolicy = { ...policy, cooldownMs: 0 };
    const g = checkInterjectGate(store, e, cfg, Math.random, t0 + 1000);
    expect(g).toEqual({ allow: false, reason: 'hourly-cap' });
  });

  it('概率闸能拦住', () => {
    const g = checkInterjectGate(store, mkEvent(), { ...policy, rate: 0.5 }, () => 0.9);
    expect(g).toEqual({ allow: false, reason: 'prob' });
  });

  it('未通过节流时不写状态（不误耗额度）', () => {
    const e = mkEvent();
    checkInterjectGate(store, e, { ...policy, enabled: false });
    // 冷却键应仍然为空
    expect(store.getKV(`interject_cd:qq:123456`)).toBeNull();
  });
});

describe('默认策略', () => {
  it('默认关闭插话', () => {
    expect(DEFAULT_POLICY.enabled).toBe(false);
  });

  it('默认阈值足够高，避免频繁开口', () => {
    expect(DEFAULT_POLICY.minMessages).toBeGreaterThanOrEqual(8);
    expect(DEFAULT_POLICY.cooldownMs).toBeGreaterThanOrEqual(600_000);
  });
});

describe('插话判断提示词', () => {
  const batch = [
    mkEvent({ sender: { userId: '1', nickname: '小明' }, text: '今天好热啊' }),
    mkEvent({ sender: { userId: '2', nickname: '小红' }, text: '是啊快化了' }),
  ];

  it('包含群聊内容与人设名', () => {
    const msgs = buildInterjectMessages(batch, '鲸鱼酱', '鲸鱼酱');
    const user = msgs[1]?.content as string;
    expect(user).toContain('小明: 今天好热啊');
    expect(user).toContain('小红: 是啊快化了');
    expect(msgs[0]?.content as string).toContain('鲸鱼酱');
  });

  it('要求只输出 JSON', () => {
    const msgs = buildInterjectMessages(batch, '鲸鱼酱', '鲸鱼酱');
    const system = msgs[0]?.content as string;
    // 断言意图而非逐字文案：提示词必须明确要求"只输出 JSON"，且给出字段名
    expect(system).toMatch(/只输出.*JSON/);
    expect(system).toContain('"speak"');
  });

  it('@ 标记被清理', () => {
    const msgs = buildInterjectMessages([mkEvent({ text: '[艾特你]在吗' })], 'b', 'b');
    expect(msgs[1]?.content as string).toContain('在吗');
    expect(msgs[1]?.content as string).not.toContain('[艾特你]');
  });
});

describe('判断结果解析', () => {
  it('解析先说 true', () => {
    const v = parseInterjectVerdict('{"speak": true, "opener": "我也热死了"}');
    expect(v.speak).toBe(true);
    expect(v.opener).toBe('我也热死了');
  });

  it('解析 speak false', () => {
    expect(parseInterjectVerdict('{"speak": false}').speak).toBe(false);
  });

  it('容忍多余文字', () => {
    const v = parseInterjectVerdict('好的，我的判断是：{"speak": true} 就这样');
    expect(v.speak).toBe(true);
  });

  it('解析失败一律不接', () => {
    expect(parseInterjectVerdict('我觉得可以接一句').speak).toBe(false);
    expect(parseInterjectVerdict('').speak).toBe(false);
    expect(parseInterjectVerdict('{"foo": 1}').speak).toBe(false);
  });

  it('空 opener 视为无', () => {
    const v = parseInterjectVerdict('{"speak": true, "opener": "  "}');
    expect(v.opener).toBeUndefined();
  });
});

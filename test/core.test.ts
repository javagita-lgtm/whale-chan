import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/core/memory.js';
import { decideTrigger } from '../src/core/trigger.js';
import { KeyedQueue } from '../src/core/pipeline.js';
import { createLogger } from '../src/core/logger.js';
import type { MessageEvent } from '../src/core/types.js';
import type { TriggerConfig } from '../src/config.js';

const silentLogger = createLogger('test');

function mkEvent(overrides: Partial<MessageEvent> = {}): MessageEvent {
  return {
    messageId: '1',
    eventId: 'e1',
    scene: 'group',
    peerId: '123456',
    sender: { userId: '1001', nickname: '小明' },
    segments: [{ type: 'text', text: '你好' }],
    text: '你好',
    mentionsBot: true,
    fromSelf: false,
    timestamp: 1700000000,
    platform: 'qq',
    ...overrides,
  };
}

const baseTrigger: TriggerConfig = {
  requireAtInGroup: true,
  groupCooldownMs: 0,
};

let dir: string;
let store: MemoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wc-test-'));
  store = new MemoryStore(dir, silentLogger);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('记忆存储', () => {
  it('去重键首次 true，重复 false', () => {
    expect(store.markSeen('k1')).toBe(true);
    expect(store.markSeen('k1')).toBe(false);
  });

  it('消息按时间升序返回且受窗口限制', () => {
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 5; i++) {
      store.appendMessage('qq', {
        scene: 'group',
        peerId: '1',
        userId: 'u',
        nickname: 'n',
        text: `m${i}`,
        mentionsBot: false,
        fromSelf: false,
        timestamp: now + i,
      });
    }
    const rows = store.recentMessages('qq', 'group', '1', 3, now - 1000);
    expect(rows.map((r) => r.text)).toEqual(['m2', 'm3', 'm4']);
  });

  it('KV 可读可覆盖', () => {
    store.setKV('a', '1');
    expect(store.getKV('a')).toBe('1');
    store.setKV('a', '2');
    expect(store.getKV('a')).toBe('2');
    expect(store.getKV('missing')).toBeNull();
  });
});

describe('触发策略', () => {
  it('自己发的消息不处理', () => {
    const d = decideTrigger(mkEvent({ fromSelf: true }), { config: baseTrigger, store });
    expect(d).toEqual({ respond: false, reason: 'self' });
  });

  it('私聊一律处理', () => {
    const d = decideTrigger(mkEvent({ scene: 'private', mentionsBot: false }), {
      config: baseTrigger,
      store,
    });
    expect(d).toEqual({ respond: true, reason: 'private' });
  });

  it('群聊 @ 才处理', () => {
    const yes = decideTrigger(mkEvent({ mentionsBot: true }), { config: baseTrigger, store });
    expect(yes).toEqual({ respond: true, reason: 'mention' });
    const no = decideTrigger(mkEvent({ messageId: '2', mentionsBot: false }), {
      config: baseTrigger,
      store,
    });
    expect(no).toEqual({ respond: false, reason: 'no-mention' });
  });

  // 旧的「每条消息掷骰子」已废弃：插话改由 InterjectObserver 攒批判断，
  // 触发器本身对未 @ 的群消息一律返回 no-mention（见 interject.test.ts）。
  it('关闭 requireAt 也不再在触发器里插话', () => {
    const cfg: TriggerConfig = { ...baseTrigger, requireAtInGroup: false };
    const d = decideTrigger(mkEvent({ mentionsBot: false }), { config: cfg, store });
    expect(d).toEqual({ respond: false, reason: 'no-mention' });
  });

  it('冷却期内不再回应', () => {
    const cfg: TriggerConfig = { ...baseTrigger, groupCooldownMs: 60_000 };
    const first = decideTrigger(mkEvent(), { config: cfg, store });
    expect(first.respond).toBe(true);
    const second = decideTrigger(mkEvent({ messageId: '2' }), { config: cfg, store });
    expect(second).toEqual({ respond: false, reason: 'cooldown' });
  });

  it('黑名单命中则静默', () => {
    const d = decideTrigger(mkEvent({ text: '广告推广' }), {
      config: baseTrigger,
      store,
      ignorePatterns: [/广告/],
    });
    expect(d).toEqual({ respond: false, reason: 'ignored' });
  });
});

describe('串行队列', () => {
  it('同 key 按加入顺序执行', async () => {
    const q = new KeyedQueue();
    const order: number[] = [];
    const slow = (n: number, ms: number) => async () => {
      await new Promise((r) => setTimeout(r, ms));
      order.push(n);
    };
    await Promise.all([
      q.enqueue('a', slow(1, 30)),
      q.enqueue('a', slow(2, 5)),
      q.enqueue('a', slow(3, 1)),
    ]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('不同 key 可并行', async () => {
    const q = new KeyedQueue();
    const order: string[] = [];
    const slow = (tag: string, ms: number) => async () => {
      await new Promise((r) => setTimeout(r, ms));
      order.push(tag);
    };
    await Promise.all([q.enqueue('a', slow('a', 30)), q.enqueue('b', slow('b', 1))]);
    expect(order).toEqual(['b', 'a']);
  });
});

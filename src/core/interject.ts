/**
 * 群聊「主动插话」观察器。
 *
 * 为什么不用「每条消息掷骰子」：
 *   群越活跃，消息越多，独立掷骰子会让调用次数随消息量线性上涨；
 *   而且真人的插话是「听一会儿 → 觉得能接一句 → 接」，不是对每条消息都表态。
 *
 * 本模块的做法：
 *   1. 非 @ 消息只**记录**，不调模型（零 token）
 *   2. 攒够 minMessages 条，或首条消息距今超过 maxWaitMs
 *   3. 用一次模型调用判断「这个话题我该不该接」
 *   4. 该接 → 正常回复；不该接 → 丢弃这批观察，重置计时
 *
 * 额外保护：
 *   - 每群冷却（interjectCooldownMs），一轮插话后静默一段时间
 *   - 每群每小时插话次数上限（maxPerHour）
 *   - 空档期：距上次群内发言超过沉默时才考虑开口，避免打断热聊
 */

import type { MessageEvent } from './types.js';
import type { MemoryStore } from './memory.js';

export interface ObserveBuffer {
  /** 这批观察到的消息（时间升序） */
  events: MessageEvent[];
  /** 首条消息的时间戳（毫秒） */
  startedAt: number;
}

export interface InterjectPolicy {
  /** 是否启用了主动插话（全局开关） */
  enabled: boolean;
  /** 攒够多少条消息后开始判断 */
  minMessages: number;
  /** 首条消息最多等待多久（毫秒）后强制判断 */
  maxWaitMs: number;
  /** 两轮插话之间的冷却（毫秒） */
  cooldownMs: number;
  /** 每群每小时最多插话几次（0 表示不限） */
  maxPerHour: number;
  /** 命中概率：模型判断「该接」后还要过这道闸 */
  rate: number;
  /**
   * 判断时喂给模型的消息条数（含上下文）。
   *
   * 这个值比 minMessages 更重要：实测同一段对话，
   * 只给 3 条模型回答「不接」，给 15 条就回答「接」——
   * 上下文太窄会把一个连贯话题切碎，模型只能保守地说不。
   */
  contextWidth: number;
}

export const DEFAULT_POLICY: InterjectPolicy = {
  enabled: false,
  minMessages: 8,
  maxWaitMs: 180_000,
  cooldownMs: 600_000,
  maxPerHour: 4,
  rate: 1.0,
  contextWidth: 15,
};

/**
 * 观察缓冲与节流状态。
 *
 * 每个群一份缓冲；判断完成后清空。
 */
export class InterjectObserver {
  private readonly buffers = new Map<string, ObserveBuffer>();

  private key(platform: string, peerId: string): string {
    return `${platform}:${peerId}`;
  }

  /** 记录一条非 @ 消息，返回是否到达判断时机。 */
  observe(event: MessageEvent, policy: InterjectPolicy, now = Date.now()): boolean {
    const k = this.key(event.platform, event.peerId);
    const buf = this.buffers.get(k);

    if (!buf) {
      this.buffers.set(k, { events: [event], startedAt: now });
      return policy.minMessages <= 1;
    }

    buf.events.push(event);
    if (buf.events.length >= policy.minMessages) return true;
    if (now - buf.startedAt >= policy.maxWaitMs) return true;
    return false;
  }

  /** 取出并清空某群的缓冲。 */
  take(platform: string, peerId: string): ObserveBuffer | null {
    const k = this.key(platform, peerId);
    const buf = this.buffers.get(k);
    if (!buf) return null;
    this.buffers.delete(k);
    return buf;
  }

  /** 丢弃某群的缓冲（判断不该插话时调用）。 */
  discard(platform: string, peerId: string): void {
    this.buffers.delete(this.key(platform, peerId));
  }

  /** 当前缓冲中的消息数（诊断用）。 */
  pending(platform: string, peerId: string): number {
    return this.buffers.get(this.key(platform, peerId))?.events.length ?? 0;
  }

  clear(): void {
    this.buffers.clear();
  }
}

export type InterjectGate =
  | { allow: true }
  | { allow: false; reason: 'disabled' | 'cooldown' | 'hourly-cap' | 'prob' };

/**
 * 检查节流条件：冷却、每小时上限、概率闸。
 * 通过时**不**写状态（真正发言后才写），避免误判把额度耗掉。
 */
export function checkInterjectGate(
  store: MemoryStore,
  event: MessageEvent,
  policy: InterjectPolicy,
  random: () => number = Math.random,
  now = Date.now(),
): InterjectGate {
  if (!policy.enabled) return { allow: false, reason: 'disabled' };

  const cooldownKey = `interject_cd:${event.platform}:${event.peerId}`;
  const last = store.getKV(cooldownKey);
  if (last !== null && now - Number(last) < policy.cooldownMs) {
    return { allow: false, reason: 'cooldown' };
  }

  if (policy.maxPerHour > 0) {
    const hourKey = `interject_hour:${event.platform}:${event.peerId}`;
    const raw = store.getKV(hourKey);
    if (raw !== null) {
      const { count, since } = JSON.parse(raw) as { count: number; since: number };
      if (now - since < 3_600_000 && count >= policy.maxPerHour) {
        return { allow: false, reason: 'hourly-cap' };
      }
    }
  }

  if (random() >= policy.rate) return { allow: false, reason: 'prob' };
  return { allow: true };
}

/** 真正插话后调用，记录冷却与小时配额。 */
export function recordInterject(
  store: MemoryStore,
  event: MessageEvent,
  now = Date.now(),
): void {
  store.setKV(`interject_cd:${event.platform}:${event.peerId}`, String(now));

  const hourKey = `interject_hour:${event.platform}:${event.peerId}`;
  const raw = store.getKV(hourKey);
  let count = 1;
  let since = now;
  if (raw !== null) {
    const prev = JSON.parse(raw) as { count: number; since: number };
    if (now - prev.since < 3_600_000) {
      count = prev.count + 1;
      since = prev.since;
    }
  }
  store.setKV(hourKey, JSON.stringify({ count, since }));
}

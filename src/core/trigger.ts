/**
 * 触发策略：决定一条消息要不要**立即**让机器人回应。
 *
 * 规则顺序（先命中先返回）：
 *   1. 自己发的 → 不处理（防自激）
 *   2. 私聊 → 一律处理
 *   3. 群聊且 @ 了自己 → 处理
 *   4. 群聊未 @ → 不立即回应（交给 InterjectObserver 攒批判断）
 *
 * 注意：主动插话**不在这里做**。早期版本在这里用「每条消息掷骰子」，
 * 会导致调用次数随群消息量线性上涨，且行为不像真人，已改为
 * src/core/interject.ts 的「攒一批再判断」。
 *
 * 另外叠加冷却：同一群在 groupCooldownMs 内只回应一次。
 */

import type { MessageEvent } from './types.js';
import type { TriggerConfig } from '../config.js';
import type { MemoryStore } from './memory.js';

export type TriggerDecision =
  | { respond: true; reason: 'private' | 'mention' }
  | { respond: false; reason: 'self' | 'no-mention' | 'ignored' | 'cooldown' };

export interface TriggerOptions {
  config: TriggerConfig;
  store: MemoryStore;
  /** 随机源，便于测试注入 */
  random?: () => number;
  /** 关键词黑名单（命中则静默） */
  ignorePatterns?: RegExp[];
}

export function decideTrigger(event: MessageEvent, options: TriggerOptions): TriggerDecision {
  if (event.fromSelf) return { respond: false, reason: 'self' };

  const patterns = options.ignorePatterns ?? [];
  if (patterns.length > 0) {
    const haystack = `${event.text} ${event.sender.nickname} ${event.sender.card ?? ''}`;
    if (patterns.some((re) => re.test(haystack))) {
      return { respond: false, reason: 'ignored' };
    }
  }

  let reason: 'private' | 'mention';
  if (event.scene === 'private') {
    reason = 'private';
  } else if (event.mentionsBot) {
    reason = 'mention';
  } else {
    // 群聊未 @：不立即回应。主动插话由 InterjectObserver 统一判断。
    return { respond: false, reason: 'no-mention' };
  }

  // 冷却检查（只对群聊生效）
  if (event.scene === 'group' && options.config.groupCooldownMs > 0) {
    const key = `cooldown:${event.platform}:${event.peerId}`;
    const last = options.store.getKV(key);
    const now = Date.now();
    if (last !== null && now - Number(last) < options.config.groupCooldownMs) {
      return { respond: false, reason: 'cooldown' };
    }
    options.store.setKV(key, String(now));
  }

  return { respond: true, reason };
}
